// api/markets.js - 完整修复版

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        let allMarkets = [];
        let offset = 0;
        
        // 获取活跃市场
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
        
        // 获取已结算市场
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

        // 处理数据
        const processed = allMarkets.map(m => {
            let priceYes = 50, priceNo = 50;
            
            // 从 outcomePrices 解析
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
            
            // 计算合计和磨损
            let totalPrice = priceYes + priceNo;
            let spread = 0;
            
            // 使用 API 的 spread 字段（买卖价差，更准确）
            if (m.spread !== undefined && m.spread !== null && parseFloat(m.spread) > 0) {
                spread = parseFloat(m.spread) * 100;
            } else if (m.bestBid !== undefined && m.bestAsk !== undefined) {
                spread = (parseFloat(m.bestAsk) - parseFloat(m.bestBid)) * 100;
            } else {
                spread = totalPrice - 100;
            }

            const category = detectCategory(m);
            
            return {
                id: m.id || m.conditionId,
                slug: m.slug || '',
                title: m.question || m.title || 'Unknown',
                category,
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
            closedMarkets: valid.length - active.length,
            totalVolume: valid.reduce((s, m) => s + m.volume, 0),
            volume24h: valid.reduce((s, m) => s + m.volume24h, 0),
            totalLiquidity: active.reduce((s, m) => s + m.liquidity, 0),
            avgSpread: active.length > 0 ? active.reduce((s, m) => s + Math.abs(m.spread), 0) / active.length : 0,
            spreadDist: {
                arb: active.filter(m => m.spread < -0.1).length,
                zero: active.filter(m => m.spread >= -0.1 && m.spread < 1).length,
                low: active.filter(m => m.spread >= 1 && m.spread < 3).length,
                mid: active.filter(m => m.spread >= 3 && m.spread < 7).length,
                high: active.filter(m => m.spread >= 7).length
            },
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
    const q = (m.question || '').toLowerCase();
    const t = (m.title || '').toLowerCase();
    const d = (m.description || '').toLowerCase();
    const tags = (m.tags || []).map(tag => (typeof tag === 'string' ? tag : tag.label || '')).join(' ').toLowerCase();
    const g = (m.groupItemTitle || '').toLowerCase();
    const text = `${q} ${t} ${d} ${tags} ${g}`;
    
    // SPORTS
    const sportsTeams = /knicks|lakers|celtics|warriors|bulls|heat|nets|76ers|suns|mavericks|bucks|clippers|spurs|hawks|hornets|pistons|pacers|magic|wizards|cavaliers|raptors|grizzlies|pelicans|timberwolves|thunder|blazers|kings|jazz|nuggets|rockets|cowboys|eagles|chiefs|49ers|bills|ravens|bengals|dolphins|lions|packers|vikings|bears|saints|buccaneers|falcons|panthers|commanders|giants|jets|patriots|steelers|browns|colts|texans|titans|jaguars|broncos|raiders|chargers|seahawks|cardinals|rams|yankees|dodgers|braves|astros|phillies|padres|mets|mariners|orioles|man city|man united|liverpool|chelsea|arsenal|tottenham|real madrid|barcelona|bayern|juventus|psg|inter milan|ac milan|atletico|dortmund|club brugge|ajax|villarreal|athletic club|eintracht frankfurt/;
    const sportsLeagues = /\bnba\b|\bnfl\b|\bnhl\b|\bmlb\b|\bufc\b|\bmma\b|premier league|champions league|la liga|bundesliga|serie a|ligue 1|world cup|euro 202|super bowl|stanley cup|world series/;
    const sportsTerms = /playoffs|finals|championship|mvp|rookie|draft|win.*vs|vs.*win|defeat|beat|match|game|halftime|overtime|penalty|touchdown|home run|knockout|points|assists|rebounds|goals/;
    
    if (sportsTeams.test(text) || sportsLeagues.test(text) || sportsTerms.test(text)) return 'Sports';
    
    // POLITICS
    const politicians = /trump|biden|harris|obama|desantis|newsom|pence|vance|walz|pelosi|mcconnell|schumer|bernie|sanders|warren|haley|ramaswamy|rfk|kennedy|yellen/;
    const politicsTerms = /president|election|vote|poll|senate|congress|governor|democrat|republican|politic|impeach|pardon|cabinet|secretary|minister|parliament|ukraine|russia|china|israel|gaza|iran|ceasefire|white house|supreme court|electoral|2024 election|2028 election/;
    
    if (politicians.test(text) || politicsTerms.test(text)) return 'Politics';
    
    // CRYPTO
    const cryptoCoins = /bitcoin|btc|\beth\b|ethereum|solana|\bsol\b|\bxrp\b|doge|cardano|polygon|matic|avalanche|chainlink|polkadot|cosmos|arbitrum|optimism|tether|usdt|usdc|bnb|shiba|pepe|bonk|wif|sui|aptos|celestia|starknet|linea|microstrategy/;
    const cryptoTerms = /crypto|defi|nft|token|blockchain|web3|binance|coinbase|etf.*bitcoin|bitcoin.*etf|halving|staking|airdrop|altcoin|memecoin/;
    
    if (cryptoCoins.test(text) || cryptoTerms.test(text)) return 'Crypto';
    
    // BUSINESS
    const companies = /tesla|apple|amazon|google|meta|microsoft|nvidia|amd|intel|openai|netflix|disney|walmart|starbucks|boeing|ford|uber|airbnb|paypal|visa|jpmorgan|goldman|blackrock|berkshire|palantir|spacex|rivian/;
    const businessTerms = /stock|nasdaq|nyse|dow|s&p|market cap|ipo|earnings|revenue|profit|quarterly|dividend|merger|acquisition|bankrupt|layoff|ceo|investor|inflation|recession|gdp|fed\b|federal reserve|interest rate|rate cut|unemployment|treasury|bond|oil|commodity|economy|company|corporate/;
    
    if (companies.test(text) || businessTerms.test(text)) return 'Business';
    
    // SCIENCE
    const scienceTerms = /\bai\b|artificial intelligence|machine learning|gpt|chatgpt|claude|llm|neural|deep learning|robot|spacex|starship|rocket|nasa|space\b|satellite|starlink|neuralink|quantum|semiconductor|chip|medicine|drug|fda|vaccine|treatment|disease|medical|agi|autonomous|self.driving|nuclear|fusion|climate/;
    
    if (scienceTerms.test(text)) return 'Science';
    
    // ENTERTAINMENT
    const entertainmentTerms = /movie|film|oscar|academy award|golden globe|emmy|grammy|album|song|artist|singer|concert|spotify|netflix|disney|hbo|streaming|tv show|actor|actress|celebrity|hollywood|taylor swift|beyonce|drake|kanye|kardashian|youtube|tiktok|influencer|gaming|esports|twitch|playstation|xbox|fortnite|minecraft|anime|marvel|star wars/;
    
    if (entertainmentTerms.test(text)) return 'Entertainment';
    
    return 'Other';
}
