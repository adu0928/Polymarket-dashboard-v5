// api/lookup.js - 完整修复版

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
        // 并行获取数据
        const [positions, activity, trades, usdcBalance] = await Promise.all([
            fetchPositions(addr),
            fetchActivity(addr),
            fetchTrades(addr),
            fetchUSDCBalance(addr)
        ]);

        // 合并历史记录
        const allHistory = mergeHistory(activity, trades);
        
        // 计算统计
        const historyStats = calcHistoryStats(allHistory);
        const positionStats = calcPositionStats(positions);

        return res.status(200).json({
            success: true,
            address: addr,
            stats: {
                usdcBalance,
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
            history: allHistory.slice(0, 100)
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message, address: addr });
    }
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
        const res = await fetch(`https://data-api.polymarket.com/activity?user=${addr}&limit=500`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    } catch (e) { return []; }
}

async function fetchTrades(addr) {
    try {
        const res = await fetch(`https://data-api.polymarket.com/trades?user=${addr}&limit=500`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    } catch (e) { return []; }
}

async function fetchUSDCBalance(addr) {
    // Polygon USDC.e 合约
    const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    // Polygon USDC (native) 合约
    const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
    
    let totalBalance = 0;
    
    // 获取 USDC.e 余额
    try {
        const url = `https://api.polygonscan.com/api?module=account&action=tokenbalance&contractaddress=${USDC}&address=${addr}&tag=latest`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            if (data.status === '1' && data.result) {
                totalBalance += parseInt(data.result) / 1e6;
            }
        }
    } catch (e) {}
    
    // 获取 USDC (native) 余额
    try {
        const url = `https://api.polygonscan.com/api?module=account&action=tokenbalance&contractaddress=${USDC_NATIVE}&address=${addr}&tag=latest`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            if (data.status === '1' && data.result) {
                totalBalance += parseInt(data.result) / 1e6;
            }
        }
    } catch (e) {}
    
    return totalBalance;
}

function mergeHistory(activity, trades) {
    const all = [];
    const seen = new Set();
    
    // 处理 activity
    activity.forEach(a => {
        const key = `${a.id || a.transactionHash || ''}-${a.timestamp || a.createdAt || ''}`;
        if (!seen.has(key)) {
            seen.add(key);
            all.push({
                id: a.id,
                type: a.type || a.side || a.action || 'unknown',
                market: a.title || a.marketSlug || a.market || a.question || 'Unknown',
                outcome: a.outcome || a.outcomeName || '',
                amount: parseFloat(a.value) || parseFloat(a.amount) || parseFloat(a.size) || parseFloat(a.usdcSize) || 0,
                price: parseFloat(a.price) || 0,
                profit: parseFloat(a.profit) || parseFloat(a.pnl) || 0,
                timestamp: a.timestamp || a.createdAt || a.time || a.blockTimestamp,
                source: 'activity'
            });
        }
    });
    
    // 处理 trades
    trades.forEach(t => {
        const key = `${t.id || t.transactionHash || ''}-${t.timestamp || t.createdAt || ''}`;
        if (!seen.has(key)) {
            seen.add(key);
            all.push({
                id: t.id,
                type: t.type || t.side || t.action || 'unknown',
                market: t.title || t.marketSlug || t.market || t.question || 'Unknown',
                outcome: t.outcome || t.outcomeName || '',
                amount: parseFloat(t.value) || parseFloat(t.amount) || parseFloat(t.size) || parseFloat(t.usdcSize) || 0,
                price: parseFloat(t.price) || 0,
                profit: parseFloat(t.profit) || parseFloat(t.pnl) || 0,
                timestamp: t.timestamp || t.createdAt || t.time || t.blockTimestamp,
                source: 'trades'
            });
        }
    });
    
    // 按时间排序（最新在前）
    all.sort((a, b) => {
        const ta = new Date(a.timestamp || 0).getTime();
        const tb = new Date(b.timestamp || 0).getTime();
        return tb - ta;
    });
    
    return all;
}

function calcHistoryStats(history) {
    let buyCount = 0, sellCount = 0, totalBuyVolume = 0, totalSellVolume = 0, realizedPnl = 0;
    const markets = new Set(), days = new Set();
    let firstDate = null, lastDate = null;
    
    history.forEach(h => {
        const type = (h.type || '').toLowerCase();
        const isBuy = type.includes('buy') || type === 'b' || type === 'market_buy' || type === 'limit_buy';
        const isSell = type.includes('sell') || type === 's' || type === 'redeem' || type === 'market_sell' || type === 'limit_sell';
        const amount = Math.abs(h.amount || 0);
        
        if (isBuy) {
            buyCount++;
            totalBuyVolume += amount;
        } else if (isSell) {
            sellCount++;
            totalSellVolume += amount;
            realizedPnl += h.profit || 0;
        } else if (amount > 0) {
            // 未知类型，计入买入
            buyCount++;
            totalBuyVolume += amount;
        }
        
        if (h.market && h.market !== 'Unknown') {
            markets.add(h.market);
        }
        
        if (h.timestamp) {
            const d = new Date(typeof h.timestamp === 'number' ? (h.timestamp > 1e12 ? h.timestamp : h.timestamp * 1000) : h.timestamp);
            if (!isNaN(d.getTime()) && d.getFullYear() > 2020) {
                days.add(d.toDateString());
                const iso = d.toISOString();
                if (!firstDate || d < new Date(firstDate)) firstDate = iso;
                if (!lastDate || d > new Date(lastDate)) lastDate = iso;
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
        const curr = parseFloat(p.currentValue) || parseFloat(p.value) || parseFloat(p.size) || 0;
        const init = parseFloat(p.initialValue) || parseFloat(p.cost) || parseFloat(p.invested) || parseFloat(p.avgPrice) * (parseFloat(p.size) || 1) || 0;
        
        currentValue += curr;
        investedAmount += init;
        
        const pnl = curr - init;
        if (pnl > 0.01) winning++;
        else if (pnl < -0.01) losing++;
    });
    
    const unrealizedPnl = currentValue - investedAmount;
    const decided = winning + losing;
    
    return {
        currentValue, investedAmount, unrealizedPnl,
        winning, losing,
        winRate: decided > 0 ? (winning / decided * 100) : 0
    };
}
