// api/markets.js

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        let allMarkets = [];
        let offset = 0;
        
        while (offset < 2000) {
            const url = `https://gamma-api.polymarket.com/markets?limit=100&offset=${offset}&closed=false`;
            const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
            if (!r.ok) break;
            const data = await r.json();
            if (!Array.isArray(data) || data.length === 0) break;
            allMarkets.push(...data);
            offset += 100;
            if (data.length < 100) break;
        }
        
        offset = 0;
        while (offset < 300) {
            const url = `https://gamma-api.polymarket.com/markets?limit=100&offset=${offset}&closed=true&order=volume&ascending=false`;
            const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
            if (!r.ok) break;
            const data = await r.json();
            if (!Array.isArray(data) || data.length === 0) break;
            allMarkets.push(...data);
            offset += 100;
            if (data.length < 100) break;
        }

        const processed = allMarkets.map(m => {
            let priceYes = 50, priceNo = 50;
            
            if (m.outcomePrices) {
                try {
                    let prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
                    if (Array.isArray(prices) && prices.length >= 2) {
                        priceYes = parseFloat(prices[0]) * 100;
                        priceNo = parseFloat(prices[1]) * 100;
                    }
                } catch (e) {}
            }
            
            if ((priceYes === 50 && priceNo === 50) && m.lastTradePrice) {
                priceYes = parseFloat(m.lastTradePrice) * 100;
                priceNo = 100 - priceYes;
            }
            
            let totalPrice = priceYes + priceNo;
            let spread = 0;
            
            if (m.spread !== undefined && parseFloat(m.spread) > 0) {
                spread = parseFloat(m.spread) * 100;
            } else if (m.bestBid !== undefined && m.bestAsk !== undefined) {
                spread = (parseFloat(m.bestAsk) - parseFloat(m.bestBid)) * 100;
            } else {
                spread = totalPrice - 100;
            }

            return {
                id: m.id || m.conditionId,
                slug: m.slug || '',
                title: m.question || m.title || 'Unknown',
                category: detectCategory(m),
                priceYes: Math.round(priceYes * 10) / 10,
                priceNo: Math.round(priceNo * 10) / 10,
                totalPrice: Math.round(totalPrice * 10) / 10,
                spread: Math.round(spread * 100) / 100,
                liquidity: parseFloat(m.liquidity) || 0,
                volume: parseFloat(m.volume) || 0,
                volume24h: parseFloat(m.volume24hr) || 0,
                endDate: m.endDate || m.endDateIso || null,
                active: !m.closed && m.active !== false,
                closed: m.closed === true
            };
        });

        const valid = processed.filter(m => m.title !== 'Unknown');
        valid.sort((a, b) => b.volume24h - a.volume24h);

        const active = valid.filter(m => m.active);
        const stats = {
            totalMarkets: valid.length,
            activeMarkets: active.length,
            totalVolume: valid.reduce((s, m) => s + m.volume, 0),
            volume24h: valid.reduce((s, m) => s + m.volume24h, 0),
            totalLiquidity: active.reduce((s, m) => s + m.liquidity, 0),
            avgSpread: active.length > 0 ? active.reduce((s, m) => s + Math.abs(m.spread), 0) / active.length : 0,
            catStats: {}
        };

        ['Politics', 'Crypto', 'Sports', 'Business', 'Science', 'Entertainment', 'Other'].forEach(cat => {
            stats.catStats[cat] = { count: 0, volume: 0, volume24h: 0, liquidity: 0 };
        });

        valid.forEach(m => {
            if (stats.catStats[m.category]) {
                stats.catStats[m.category].count++;
                stats.catStats[m.category].volume += m.volume;
                stats.catStats[m.category].volume24h += m.volume24h;
                stats.catStats[m.category].liquidity += m.liquidity;
            }
        });

        return res.status(200).json({ success: true, count: valid.length, stats, markets: valid });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
}

function detectCategory(m) {
    const text = `${m.question || ''} ${m.title || ''} ${m.description || ''} ${(m.tags || []).map(t => typeof t === 'string' ? t : t.label || '').join(' ')} ${m.groupItemTitle || ''}`.toLowerCase();
    
    if (text.match(/knicks|lakers|celtics|warriors|bulls|heat|nets|76ers|suns|mavericks|bucks|clippers|spurs|cowboys|eagles|chiefs|49ers|bills|ravens|yankees|dodgers|braves|man city|man united|liverpool|chelsea|arsenal|real madrid|barcelona|bayern|juventus|psg|nba|nfl|nhl|mlb|ufc|mma|premier league|champions league|la liga|bundesliga|serie a|super bowl|playoffs|finals|championship|mvp/)) return 'Sports';
    if (text.match(/trump|biden|harris|obama|desantis|president|election|vote|senate|congress|governor|democrat|republican|politic|ukraine|russia|china|israel|gaza|white house|electoral/)) return 'Politics';
    if (text.match(/bitcoin|btc|ethereum|eth|solana|sol|xrp|doge|cardano|polygon|avalanche|chainlink|crypto|defi|nft|token|blockchain|binance|coinbase|etf.*bitcoin|bitcoin.*etf|halving|airdrop|microstrategy/)) return 'Crypto';
    if (text.match(/tesla|apple|amazon|google|meta|microsoft|nvidia|stock|nasdaq|nyse|dow|s&p|ipo|earnings|revenue|profit|merger|acquisition|ceo|inflation|recession|gdp|fed|federal reserve|interest rate|economy/)) return 'Business';
    if (text.match(/\bai\b|artificial intelligence|gpt|chatgpt|claude|llm|spacex|starship|nasa|space|quantum|medicine|drug|fda|vaccine|agi|robot/)) return 'Science';
    if (text.match(/movie|film|oscar|emmy|grammy|album|spotify|netflix|disney|streaming|actor|celebrity|taylor swift|beyonce|youtube|tiktok|gaming|esports|fortnite|minecraft|marvel/)) return 'Entertainment';
    return 'Other';
}
