// api/lookup.js - 修复所有数据显示

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
        const [positions, activity, trades, usdcBalance] = await Promise.all([
            fetchPositions(addr),
            fetchActivity(addr),
            fetchTrades(addr),
            fetchUSDCViaRPC(addr)
        ]);

        // 合并所有历史记录
        const allHistory = processAllHistory(activity, trades);
        
        // 计算统计
        const historyStats = calcHistoryStats(allHistory);
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
                totalTrades: allHistory.length,
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
            history: allHistory // 返回所有历史记录
        });
    } catch (error) {
        console.error('Lookup error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}

async function fetchUSDCViaRPC(addr) {
    const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
    
    let total = 0;
    const rpcUrls = ['https://polygon-rpc.com', 'https://rpc.ankr.com/polygon', 'https://polygon.llamarpc.com'];
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
                        }
                        break;
                    }
                }
            } catch (e) {}
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
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    } catch (e) { return []; }
}

async function fetchActivity(addr) {
    try {
        const res = await fetch(`https://data-api.polymarket.com/activity?user=${addr}&limit=1000`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    } catch (e) { return []; }
}

async function fetchTrades(addr) {
    try {
        const res = await fetch(`https://data-api.polymarket.com/trades?user=${addr}&limit=1000`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    } catch (e) { return []; }
}

function processAllHistory(activity, trades) {
    const all = [];
    const seen = new Set();
    
    // 处理 activity
    activity.forEach(a => {
        const key = `activity-${a.id || ''}-${a.transactionHash || ''}-${a.timestamp || a.createdAt || Math.random()}`;
        if (seen.has(key)) return;
        seen.add(key);
        
        // 判断交易类型
        let type = determineTradeType(a);
        
        const amount = Math.abs(
            parseFloat(a.usdcSize) || 
            parseFloat(a.value) || 
            parseFloat(a.amount) || 
            parseFloat(a.size) * (parseFloat(a.price) || 1) || 
            0
        );
        
        all.push({
            id: a.id,
            type: type,
            market: a.title || a.marketSlug || a.market || a.question || a.conditionId || 'Unknown',
            outcome: a.outcome || a.outcomeName || '',
            amount: amount,
            price: parseFloat(a.price) || 0,
            profit: parseFloat(a.profit) || parseFloat(a.pnl) || 0,
            timestamp: a.timestamp || a.createdAt || a.time || a.blockTimestamp,
            source: 'activity'
        });
    });
    
    // 处理 trades
    trades.forEach(t => {
        const key = `trades-${t.id || ''}-${t.transactionHash || ''}-${t.timestamp || t.createdAt || Math.random()}`;
        if (seen.has(key)) return;
        seen.add(key);
        
        let type = determineTradeType(t);
        
        const amount = Math.abs(
            parseFloat(t.usdcSize) || 
            parseFloat(t.value) || 
            parseFloat(t.amount) || 
            parseFloat(t.size) * (parseFloat(t.price) || 1) || 
            0
        );
        
        all.push({
            id: t.id,
            type: type,
            market: t.title || t.marketSlug || t.market || t.question || t.conditionId || 'Unknown',
            outcome: t.outcome || t.outcomeName || '',
            amount: amount,
            price: parseFloat(t.price) || 0,
            profit: parseFloat(t.profit) || parseFloat(t.pnl) || 0,
            timestamp: t.timestamp || t.createdAt || t.time || t.blockTimestamp,
            source: 'trades'
        });
    });
    
    // 按时间排序
    all.sort((a, b) => {
        const ta = parseTimestamp(a.timestamp);
        const tb = parseTimestamp(b.timestamp);
        return tb - ta;
    });
    
    return all;
}

function determineTradeType(item) {
    const side = (item.side || '').toUpperCase();
    const type = (item.type || '').toLowerCase();
    const action = (item.action || '').toLowerCase();
    
    // 检查 side 字段
    if (side === 'BUY' || side === 'B') return 'buy';
    if (side === 'SELL' || side === 'S') return 'sell';
    
    // 检查 type 字段
    if (type.includes('buy') || type === 'b' || type === 'bid') return 'buy';
    if (type.includes('sell') || type === 's' || type === 'ask' || type === 'redeem') return 'sell';
    
    // 检查 action 字段
    if (action.includes('buy') || action === 'b') return 'buy';
    if (action.includes('sell') || action === 's' || action === 'redeem') return 'sell';
    
    // 检查 isBuy 字段
    if (item.isBuy === true) return 'buy';
    if (item.isBuy === false) return 'sell';
    
    // 默认为交易
    return 'trade';
}

function parseTimestamp(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') {
        return ts > 1e12 ? ts : ts * 1000;
    }
    const d = new Date(ts);
    return isNaN(d.getTime()) ? 0 : d.getTime();
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
        } else {
            // trade 类型，计入买入
            buyCount++;
            totalBuyVolume += h.amount;
        }
        
        if (h.market && h.market !== 'Unknown') {
            markets.add(h.market);
        }
        
        const ts = parseTimestamp(h.timestamp);
        if (ts > 0) {
            const d = new Date(ts);
            if (d.getFullYear() >= 2020 && d.getFullYear() <= 2030) {
                days.add(d.toDateString());
                const iso = d.toISOString();
                if (!firstDate || ts < parseTimestamp(firstDate)) firstDate = iso;
                if (!lastDate || ts > parseTimestamp(lastDate)) lastDate = iso;
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
    let currentValue = 0, investedAmount = 0, winning = 0, losing = 0, neutral = 0;
    
    positions.forEach(p => {
        const size = parseFloat(p.size) || 0;
        const price = parseFloat(p.price) || parseFloat(p.currentPrice) || 0;
        const avgPrice = parseFloat(p.avgPrice) || parseFloat(p.averagePrice) || 0;
        
        const curr = parseFloat(p.currentValue) || parseFloat(p.value) || (size * price) || 0;
        const init = parseFloat(p.initialValue) || parseFloat(p.cost) || parseFloat(p.invested) || (size * avgPrice) || 0;
        
        currentValue += curr;
        investedAmount += init;
        
        if (init > 0.1) {
            const pnlPct = (curr - init) / init;
            if (pnlPct > 0.02) winning++;
            else if (pnlPct < -0.02) losing++;
            else neutral++;
        }
    });
    
    const total = winning + losing;
    
    return {
        currentValue, investedAmount,
        unrealizedPnl: currentValue - investedAmount,
        winning, losing, neutral,
        winRate: total > 0 ? Math.round(winning / total * 100) : 0
    };
}
