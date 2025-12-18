// api/lookup.js - 使用RPC直接获取USDC余额

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { address } = req.query;
    if (!address || !address.match(/^0x[a-fA-F0-9]{40}$/i)) {
        return res.status(400).json({ error: 'Invalid address' });
    }

    const addr = address.toLowerCase();
    
    try {
        // 并行获取所有数据
        const [positions, history, usdcBalance] = await Promise.all([
            fetchPositions(addr),
            fetchAllHistory(addr),
            fetchUSDCViaRPC(addr)
        ]);

        // 计算统计
        const historyStats = calcHistoryStats(history);
        const positionStats = calcPositionStats(positions);

        return res.status(200).json({
            success: true,
            address: addr,
            stats: {
                usdcBalance: usdcBalance,
                positionCount: positions.length,
                portfolioValue: positionStats.currentValue,
                investedAmount: positionStats.investedAmount,
                unrealizedPnl: positionStats.unrealizedPnl,
                totalTrades: history.length,
                buyCount: historyStats.buyCount,
                sellCount: historyStats.sellCount,
                totalBuyVolume: historyStats.totalBuyVolume,
                totalSellVolume: historyStats.totalSellVolume,
                totalVolume: historyStats.totalVolume,
                realizedPnl: historyStats.realizedPnl,
                marketsParticipated: historyStats.marketsCount,
                activeDays: historyStats.activeDays,
                firstTradeDate: historyStats.firstDate,
                lastTradeDate: historyStats.lastDate,
                winningPositions: positionStats.winning,
                losingPositions: positionStats.losing,
                winRate: positionStats.winRate
            },
            positions: positions.slice(0, 50),
            history: history.slice(0, 100)
        });
    } catch (error) {
        console.error('Lookup error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}

// 使用 Polygon RPC 直接获取 USDC 余额
async function fetchUSDCViaRPC(addr) {
    // USDC.e on Polygon
    const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    // Native USDC on Polygon
    const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
    
    let total = 0;
    
    // 多个RPC端点备用
    const rpcUrls = [
        'https://polygon-rpc.com',
        'https://rpc.ankr.com/polygon',
        'https://polygon.llamarpc.com'
    ];
    
    // balanceOf(address) = 0x70a08231 + address padded to 32 bytes
    const paddedAddr = '000000000000000000000000' + addr.slice(2);
    const callData = '0x70a08231' + paddedAddr;
    
    for (const contract of [USDC_E, USDC_NATIVE]) {
        for (const rpcUrl of rpcUrls) {
            try {
                const response = await fetch(rpcUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'eth_call',
                        params: [{ to: contract, data: callData }, 'latest'],
                        id: 1
                    })
                });
                
                if (response.ok) {
                    const json = await response.json();
                    if (json.result && json.result !== '0x' && json.result !== '0x0') {
                        const balance = parseInt(json.result, 16) / 1e6;
                        if (balance > 0) {
                            total += balance;
                            console.log(`Got ${balance} USDC from ${contract} via ${rpcUrl}`);
                        }
                        break; // 成功获取，不需要尝试其他RPC
                    }
                }
            } catch (e) {
                console.log(`RPC ${rpcUrl} failed:`, e.message);
            }
        }
    }
    
    return total;
}

async function fetchPositions(addr) {
    try {
        const res = await fetch(`https://data-api.polymarket.com/positions?user=${addr}`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });
        if (!res.ok) return [];
        return await res.json() || [];
    } catch (e) { return []; }
}

async function fetchAllHistory(addr) {
    const all = [];
    const seen = new Set();
    
    // 获取 activity
    try {
        const res = await fetch(`https://data-api.polymarket.com/activity?user=${addr}&limit=1000`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data)) {
                data.forEach(a => processHistoryItem(a, all, seen));
            }
        }
    } catch (e) {}
    
    // 获取 trades
    try {
        const res = await fetch(`https://data-api.polymarket.com/trades?user=${addr}&limit=1000`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data)) {
                data.forEach(t => processHistoryItem(t, all, seen));
            }
        }
    } catch (e) {}
    
    // 按时间排序
    all.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    return all;
}

function processHistoryItem(item, all, seen) {
    const key = `${item.id || ''}-${item.transactionHash || ''}-${item.timestamp || item.createdAt || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    
    // 判断交易类型
    let type = 'unknown';
    const side = (item.side || item.type || item.action || '').toUpperCase();
    
    if (side === 'BUY' || side === 'B' || side.includes('BUY')) {
        type = 'buy';
    } else if (side === 'SELL' || side === 'S' || side.includes('SELL') || side === 'REDEEM') {
        type = 'sell';
    }
    
    // 如果还是unknown，检查其他字段
    if (type === 'unknown') {
        // 检查是否有 isBuy 字段
        if (item.isBuy === true) type = 'buy';
        else if (item.isBuy === false) type = 'sell';
        // 检查 maker/taker 和方向
        else if (item.makerSide) {
            type = item.makerSide.toLowerCase().includes('buy') ? 'buy' : 'sell';
        }
    }
    
    const amount = Math.abs(
        parseFloat(item.usdcSize) || 
        parseFloat(item.value) || 
        parseFloat(item.amount) || 
        parseFloat(item.size) * (parseFloat(item.price) || 1) || 
        0
    );
    
    all.push({
        id: item.id,
        type: type,
        market: item.title || item.marketSlug || item.market || item.question || 'Unknown',
        outcome: item.outcome || item.outcomeName || '',
        amount: amount,
        price: parseFloat(item.price) || 0,
        profit: parseFloat(item.profit) || parseFloat(item.pnl) || 0,
        timestamp: item.timestamp || item.createdAt || item.time
    });
}

function calcHistoryStats(history) {
    let buyCount = 0, sellCount = 0, totalBuyVolume = 0, totalSellVolume = 0, realizedPnl = 0;
    const markets = new Set(), days = new Set();
    let firstDate = null, lastDate = null;
    
    history.forEach(h => {
        if (h.type === 'buy') {
            buyCount++;
            totalBuyVolume += h.amount;
        } else if (h.type === 'sell') {
            sellCount++;
            totalSellVolume += h.amount;
            realizedPnl += h.profit || 0;
        } else if (h.amount > 0) {
            // 未知类型但有金额，平均分配
            buyCount++;
            totalBuyVolume += h.amount;
        }
        
        if (h.market && h.market !== 'Unknown') markets.add(h.market);
        
        if (h.timestamp) {
            const d = new Date(h.timestamp);
            if (!isNaN(d.getTime()) && d.getFullYear() >= 2020 && d.getFullYear() <= 2030) {
                days.add(d.toDateString());
                if (!firstDate || d < new Date(firstDate)) firstDate = d.toISOString();
                if (!lastDate || d > new Date(lastDate)) lastDate = d.toISOString();
            }
        }
    });
    
    return {
        buyCount, sellCount, totalBuyVolume, totalSellVolume,
        totalVolume: totalBuyVolume + totalSellVolume,
        realizedPnl, marketsCount: markets.size, activeDays: days.size,
        firstDate, lastDate
    };
}

function calcPositionStats(positions) {
    let currentValue = 0, investedAmount = 0, winning = 0, losing = 0;
    
    positions.forEach(p => {
        const size = parseFloat(p.size) || 0;
        const price = parseFloat(p.price) || parseFloat(p.currentPrice) || 0;
        const avgPrice = parseFloat(p.avgPrice) || parseFloat(p.averagePrice) || 0;
        
        const curr = parseFloat(p.currentValue) || (size * price) || 0;
        const init = parseFloat(p.initialValue) || parseFloat(p.cost) || (size * avgPrice) || 0;
        
        currentValue += curr;
        investedAmount += init;
        
        if (init > 0) {
            const pnlPct = (curr - init) / init;
            if (pnlPct > 0.01) winning++;
            else if (pnlPct < -0.01) losing++;
        }
    });
    
    const total = winning + losing;
    
    return {
        currentValue, investedAmount,
        unrealizedPnl: currentValue - investedAmount,
        winning, losing,
        winRate: total > 0 ? Math.round(winning / total * 100) : 0
    };
}
