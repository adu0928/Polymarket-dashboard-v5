// api/lookup.js - 地址查询

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
        const [positions, history, usdcBalance] = await Promise.all([
            fetchPositions(addr),
            fetchHistory(addr),
            fetchUSDCBalance(addr)
        ]);

        const historyStats = calcHistoryStats(history);
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
                neutralPositions: positionStats.neutral,
                winRate: positionStats.winRate,
                estimatedLpRewards: historyStats.totalVolume * 0.001
            },
            positions,
            history
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

async function fetchHistory(addr) {
    const all = [];
    const urls = [
        `https://data-api.polymarket.com/activity?user=${addr}&limit=1000`,
        `https://data-api.polymarket.com/trades?user=${addr}&limit=1000`
    ];
    
    for (const url of urls) {
        try {
            const res = await fetch(url, {
                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
            });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) all.push(...data);
            }
        } catch (e) {}
    }
    
    // 去重
    const seen = new Set();
    return all.filter(h => {
        const key = `${h.id || ''}-${h.timestamp || h.createdAt || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function fetchUSDCBalance(addr) {
    const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    
    try {
        const url = `https://api.polygonscan.com/api?module=account&action=tokenbalance&contractaddress=${USDC}&address=${addr}&tag=latest`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            if (data.status === '1' && data.result) {
                return parseInt(data.result) / 1e6;
            }
        }
    } catch (e) {}
    
    try {
        const res = await fetch(`https://data-api.polymarket.com/balance?user=${addr}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (res.ok) {
            const data = await res.json();
            return parseFloat(data.balance || data.usdc || 0);
        }
    } catch (e) {}
    
    return 0;
}

function calcHistoryStats(history) {
    let buyCount = 0, sellCount = 0, totalBuyVolume = 0, totalSellVolume = 0, realizedPnl = 0;
    const markets = new Set(), days = new Set();
    let firstDate = null, lastDate = null;
    
    history.forEach(h => {
        const type = (h.type || h.side || h.action || '').toLowerCase();
        const isBuy = type.includes('buy') || type === 'b';
        const isSell = type.includes('sell') || type === 's' || type.includes('redeem');
        const value = Math.abs(parseFloat(h.value) || parseFloat(h.amount) || parseFloat(h.size) || parseFloat(h.usdcSize) || 0);
        const profit = parseFloat(h.profit) || parseFloat(h.pnl) || 0;
        
        if (isBuy) { buyCount++; totalBuyVolume += value; }
        else if (isSell) { sellCount++; totalSellVolume += value; realizedPnl += profit; }
        
        if (h.marketSlug || h.market) markets.add(h.marketSlug || h.market);
        
        const ts = h.timestamp || h.createdAt || h.time;
        if (ts) {
            const d = new Date(typeof ts === 'number' ? (ts > 1e12 ? ts : ts * 1000) : ts);
            if (!isNaN(d.getTime()) && d.getFullYear() > 2020) {
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
    let currentValue = 0, investedAmount = 0, winning = 0, losing = 0, neutral = 0;
    
    positions.forEach(p => {
        const curr = parseFloat(p.currentValue) || parseFloat(p.value) || 0;
        const init = parseFloat(p.initialValue) || parseFloat(p.cost) || parseFloat(p.invested) || 0;
        currentValue += curr;
        investedAmount += init;
        const pnl = curr - init;
        if (pnl > 0.01) winning++;
        else if (pnl < -0.01) losing++;
        else neutral++;
    });
    
    const unrealizedPnl = currentValue - investedAmount;
    const decided = winning + losing;
    
    return {
        currentValue, investedAmount, unrealizedPnl,
        winning, losing, neutral,
        winRate: decided > 0 ? (winning / decided * 100) : 0
    };
}
