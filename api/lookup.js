// api/lookup.js - 地址查询，获取完整历史和正确统计

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { address } = req.query;

    if (!address || !address.match(/^0x[a-fA-F0-9]{40}$/i)) {
        return res.status(400).json({ error: 'Invalid address' });
    }

    const addr = address.toLowerCase();
    
    try {
        // 并行获取所有数据
        const [positions, history, polygonData] = await Promise.all([
            fetchPositions(addr),
            fetchFullHistory(addr),
            fetchPolygonData(addr)
        ]);

        // 从历史记录计算统计
        const historyStats = calculateHistoryStats(history);
        
        // 从持仓计算统计
        const positionStats = calculatePositionStats(positions);

        // 合并统计
        const stats = {
            // Polygon 数据
            usdcBalance: polygonData.usdcBalance,
            
            // 持仓相关
            positionCount: positions.length,
            portfolioValue: positionStats.currentValue,
            investedAmount: positionStats.investedAmount,
            unrealizedPnl: positionStats.unrealizedPnl,
            unrealizedPnlPct: positionStats.unrealizedPnlPct,
            
            // 历史交易统计
            totalTrades: history.length,
            buyCount: historyStats.buyCount,
            sellCount: historyStats.sellCount,
            totalBuyVolume: historyStats.totalBuyVolume,
            totalSellVolume: historyStats.totalSellVolume,
            totalVolume: historyStats.totalVolume,
            realizedPnl: historyStats.realizedPnl,
            
            // 市场参与
            marketsParticipated: historyStats.marketsParticipated,
            activeDays: historyStats.activeDays,
            firstTradeDate: historyStats.firstTradeDate,
            lastTradeDate: historyStats.lastTradeDate,
            
            // 盈亏统计
            winningPositions: positionStats.winning,
            losingPositions: positionStats.losing,
            neutralPositions: positionStats.neutral,
            winRate: positionStats.winRate,
            
            // LP奖励估算
            estimatedLpRewards: historyStats.totalVolume * 0.001
        };

        return res.status(200).json({
            success: true,
            address: addr,
            stats: stats,
            positions: positions,
            history: history.slice(0, 200) // 最近200条
        });

    } catch (error) {
        console.error('Lookup error:', error);
        return res.status(500).json({ 
            success: false, 
            error: error.message,
            address: addr
        });
    }
}

// 获取持仓
async function fetchPositions(address) {
    try {
        const response = await fetch(
            `https://data-api.polymarket.com/positions?user=${address}`,
            { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }
        );
        
        if (!response.ok) return [];
        
        const data = await response.json();
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.error('Fetch positions error:', e.message);
        return [];
    }
}

// 获取完整历史 - 分页获取所有
async function fetchFullHistory(address) {
    const allHistory = [];
    let offset = 0;
    const limit = 500;
    
    while (offset < 5000) { // 最多获取5000条
        try {
            const response = await fetch(
                `https://data-api.polymarket.com/activity?user=${address}&limit=${limit}&offset=${offset}`,
                { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }
            );
            
            if (!response.ok) break;
            
            const data = await response.json();
            if (!Array.isArray(data) || data.length === 0) break;
            
            allHistory.push(...data);
            offset += limit;
            
            if (data.length < limit) break;
        } catch (e) {
            break;
        }
    }
    
    return allHistory;
}

// 获取 Polygon 数据
async function fetchPolygonData(address) {
    const result = { usdcBalance: 0 };
    
    try {
        // USDC.e on Polygon
        const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
        const response = await fetch(
            `https://api.polygonscan.com/api?module=account&action=tokenbalance&contractaddress=${USDC}&address=${address}&tag=latest`
        );
        
        if (response.ok) {
            const data = await response.json();
            if (data.status === '1' && data.result) {
                result.usdcBalance = parseInt(data.result) / 1e6;
            }
        }
    } catch (e) {
        console.error('Polygon fetch error:', e.message);
    }
    
    return result;
}

// 从历史记录计算统计
function calculateHistoryStats(history) {
    const stats = {
        buyCount: 0,
        sellCount: 0,
        totalBuyVolume: 0,
        totalSellVolume: 0,
        totalVolume: 0,
        realizedPnl: 0,
        marketsParticipated: 0,
        activeDays: 0,
        firstTradeDate: null,
        lastTradeDate: null
    };
    
    if (history.length === 0) return stats;
    
    const markets = new Set();
    const days = new Set();
    
    history.forEach(h => {
        const type = (h.type || h.side || '').toLowerCase();
        const value = Math.abs(parseFloat(h.value) || parseFloat(h.amount) || 0);
        const profit = parseFloat(h.profit) || parseFloat(h.pnl) || 0;
        
        if (type === 'buy' || type === 'b') {
            stats.buyCount++;
            stats.totalBuyVolume += value;
        } else if (type === 'sell' || type === 's' || type === 'redeem') {
            stats.sellCount++;
            stats.totalSellVolume += value;
            stats.realizedPnl += profit;
        }
        
        stats.totalVolume += value;
        
        // 市场参与
        if (h.marketSlug || h.market) {
            markets.add(h.marketSlug || h.market);
        }
        
        // 活跃天数
        if (h.timestamp || h.createdAt) {
            const date = new Date(h.timestamp || h.createdAt);
            days.add(date.toDateString());
            
            if (!stats.firstTradeDate || date < new Date(stats.firstTradeDate)) {
                stats.firstTradeDate = date.toISOString();
            }
            if (!stats.lastTradeDate || date > new Date(stats.lastTradeDate)) {
                stats.lastTradeDate = date.toISOString();
            }
        }
    });
    
    stats.marketsParticipated = markets.size;
    stats.activeDays = days.size;
    
    return stats;
}

// 从持仓计算统计
function calculatePositionStats(positions) {
    const stats = {
        currentValue: 0,
        investedAmount: 0,
        unrealizedPnl: 0,
        unrealizedPnlPct: 0,
        winning: 0,
        losing: 0,
        neutral: 0,
        winRate: 0
    };
    
    if (positions.length === 0) return stats;
    
    positions.forEach(p => {
        const current = parseFloat(p.currentValue) || parseFloat(p.value) || 0;
        const initial = parseFloat(p.initialValue) || parseFloat(p.cost) || parseFloat(p.invested) || 0;
        
        stats.currentValue += current;
        stats.investedAmount += initial;
        
        const pnl = current - initial;
        
        if (pnl > 0.01) {
            stats.winning++;
        } else if (pnl < -0.01) {
            stats.losing++;
        } else {
            stats.neutral++;
        }
    });
    
    stats.unrealizedPnl = stats.currentValue - stats.investedAmount;
    stats.unrealizedPnlPct = stats.investedAmount > 0 
        ? (stats.unrealizedPnl / stats.investedAmount * 100) 
        : 0;
    
    const decidedPositions = stats.winning + stats.losing;
    stats.winRate = decidedPositions > 0 
        ? (stats.winning / decidedPositions * 100) 
        : 0;
    
    return stats;
}
