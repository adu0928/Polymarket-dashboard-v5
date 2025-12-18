// api/markets.js - 获取所有Polymarket市场，正确计算磨损

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        console.log('Fetching all markets from Polymarket...');
        
        let allMarkets = [];
        let offset = 0;
        const limit = 100;
        
        // 获取活跃市场
        while (offset < 2000) {
            const url = `https://gamma-api.polymarket.com/markets?limit=${limit}&offset=${offset}&closed=false`;
            const response = await fetch(url, {
                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
            });
            
            if (!response.ok) break;
            const data = await response.json();
            if (!Array.isArray(data) || data.length === 0) break;
            
            allMarkets.push(...data);
            offset += limit;
            if (data.length < limit) break;
        }
        
        // 获取已结算市场
        offset = 0;
        while (offset < 500) {
            const url = `https://gamma-api.polymarket.com/markets?limit=${limit}&offset=${offset}&closed=true&order=volume&ascending=false`;
            const response = await fetch(url, {
                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
            });
            
            if (!response.ok) break;
            const data = await response.json();
            if (!Array.isArray(data) || data.length === 0) break;
            
            allMarkets.push(...data);
            offset += limit;
            if (data.length < limit) break;
        }

        console.log('Total raw markets:', allMarkets.length);

        // 处理数据 - 正确计算磨损
        const processed = allMarkets.map(m => {
            // 解析价格 - 处理多种格式
            let priceYes = 0, priceNo = 0;
            
            try {
                if (m.outcomePrices) {
                    let prices = m.outcomePrices;
                    if (typeof prices === 'string') {
                        prices = JSON.parse(prices);
                    }
                    
                    if (Array.isArray(prices) && prices.length >= 2) {
                        priceYes = parseFloat(prices[0]) || 0;
                        priceNo = parseFloat(prices[1]) || 0;
                        
                        // 如果是0-1的小数，转换为百分比
                        if (priceYes <= 1 && priceNo <= 1) {
                            priceYes = priceYes * 100;
                            priceNo = priceNo * 100;
                        }
                    }
                }
                
                // 备用：从bestBid/bestAsk计算
                if ((priceYes === 0 || priceNo === 0) && m.bestBid !== undefined) {
                    priceYes = parseFloat(m.bestAsk || m.bestBid || 0.5) * 100;
                    priceNo = 100 - priceYes;
                }
            } catch (e) {
                console.log('Price parse error:', e.message);
            }

            // 计算磨损/套利
            // 磨损 = (Yes + No) - 100  正数=磨损，负数=套利机会
            const totalPrice = priceYes + priceNo;
            const spread = totalPrice - 100;
            
            const category = detectCategory(m);
            
            return {
                id: m.id || m.conditionId,
                slug: m.slug || '',
                title: m.question || m.title || 'Unknown',
                description: m.description || '',
                category: category,
                priceYes: Math.round(priceYes * 100) / 100,
                priceNo: Math.round(priceNo * 100) / 100,
                totalPrice: Math.round(totalPrice * 100) / 100,
                spread: Math.round(spread * 100) / 100, // 正=磨损，负=套利
                liquidity: parseFloat(m.liquidity) || 0,
                volume: parseFloat(m.volume) || 0,
                volume24h: parseFloat(m.volume24hr) || parseFloat(m.volume24h) || 0,
                endDate: m.endDate || m.endDateIso || null,
                active: !m.closed && m.active !== false,
                closed: m.closed === true,
                image: m.image || null,
                // 原始数据用于调试
                rawPrices: m.outcomePrices
            };
        });

        // 过滤掉无效数据
        const valid = processed.filter(m => m.priceYes > 0 || m.priceNo > 0);
        
        // 按24h成交排序
        valid.sort((a, b) => b.volume24h - a.volume24h);

        // 计算统计
        const activeMarkets = valid.filter(m => m.active);
        const stats = {
            totalMarkets: valid.length,
            activeMarkets: activeMarkets.length,
            closedMarkets: valid.length - activeMarkets.length,
            totalVolume: valid.reduce((s, m) => s + m.volume, 0),
            volume24h: valid.reduce((s, m) => s + m.volume24h, 0),
            totalLiquidity: activeMarkets.reduce((s, m) => s + m.liquidity, 0),
            avgSpread: activeMarkets.length > 0 
                ? activeMarkets.reduce((s, m) => s + m.spread, 0) / activeMarkets.length 
                : 0,
            // 磨损分布
            spreadDistribution: {
                negative: activeMarkets.filter(m => m.spread < 0).length, // 套利机会
                zero: activeMarkets.filter(m => m.spread >= 0 && m.spread < 0.5).length,
                low: activeMarkets.filter(m => m.spread >= 0.5 && m.spread < 2).length,
                medium: activeMarkets.filter(m => m.spread >= 2 && m.spread < 5).length,
                high: activeMarkets.filter(m => m.spread >= 5).length
            },
            // 类别统计
            categoryStats: {}
        };

        // 类别统计
        valid.forEach(m => {
            if (!stats.categoryStats[m.category]) {
                stats.categoryStats[m.category] = { count: 0, volume: 0, volume24h: 0, liquidity: 0 };
            }
            stats.categoryStats[m.category].count++;
            stats.categoryStats[m.category].volume += m.volume;
            stats.categoryStats[m.category].volume24h += m.volume24h;
            stats.categoryStats[m.category].liquidity += m.liquidity;
        });

        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
        return res.status(200).json({
            success: true,
            count: valid.length,
            timestamp: new Date().toISOString(),
            stats: stats,
            markets: valid
        });

    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}

function detectCategory(m) {
    const text = ((m.question || '') + ' ' + (m.title || '') + ' ' + (m.description || '') + ' ' + ((m.tags || []).join(' '))).toLowerCase();
    
    if (text.match(/trump|biden|election|president|congress|senate|politic|vote|democrat|republican|governor|cabinet|pardon|impeach/)) return 'Politics';
    if (text.match(/bitcoin|btc|ethereum|eth|crypto|solana|sol|xrp|doge|token|defi|nft|coinbase|binance|sec.*crypto/)) return 'Crypto';
    if (text.match(/super bowl|nba|nfl|ufc|premier league|champion|league|sport|playoff|finals|world series|wimbledon|mvp|f1|formula/)) return 'Sports';
    if (text.match(/fed\s|stock|inflation|gdp|company|ceo|rate cut|market|economy|ipo|earning|nasdaq|dow|s&p|tesla|apple|amazon|google|nvidia/)) return 'Business';
    if (text.match(/oscar|grammy|emmy|movie|film|taylor|entertainment|album|song|netflix|disney|streaming|award/)) return 'Entertainment';
    if (text.match(/ai\s|gpt|openai|spacex|tech|science|nasa|space|rocket|robot|quantum|fusion/)) return 'Science';
    
    return 'Other';
}
