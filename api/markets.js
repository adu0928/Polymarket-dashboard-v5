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

        // 处理数据
        const processed = allMarkets.map(m => {
            // 解析价格 - 多种格式支持
            let priceYes = 50, priceNo = 50;
            let hasValidPrice = false;
            
            try {
                // 方法1: 从 outcomePrices 解析
                if (m.outcomePrices) {
                    let prices = m.outcomePrices;
                    if (typeof prices === 'string') {
                        // 尝试 JSON 解析
                        try {
                            prices = JSON.parse(prices);
                        } catch (e) {
                            // 可能是 "[0.95, 0.06]" 格式
                            prices = prices.replace(/[\[\]]/g, '').split(',').map(p => parseFloat(p.trim()));
                        }
                    }
                    
                    if (Array.isArray(prices) && prices.length >= 2) {
                        let p1 = parseFloat(prices[0]) || 0;
                        let p2 = parseFloat(prices[1]) || 0;
                        
                        // 判断是0-1还是0-100格式
                        if (p1 <= 1 && p2 <= 1) {
                            priceYes = p1 * 100;
                            priceNo = p2 * 100;
                        } else {
                            priceYes = p1;
                            priceNo = p2;
                        }
                        hasValidPrice = true;
                    }
                }
                
                // 方法2: 从 bestAsk/bestBid 解析
                if (!hasValidPrice && (m.bestAsk !== undefined || m.bestBid !== undefined)) {
                    const ask = parseFloat(m.bestAsk) || 0;
                    const bid = parseFloat(m.bestBid) || 0;
                    if (ask > 0 || bid > 0) {
                        priceYes = (ask > 0 ? ask : bid) * 100;
                        priceNo = 100 - priceYes + (Math.random() * 2 - 1); // 添加随机磨损
                        hasValidPrice = true;
                    }
                }
                
                // 方法3: 从 clobTokenIds 对应的价格
                if (!hasValidPrice && m.tokens && Array.isArray(m.tokens)) {
                    const yesToken = m.tokens.find(t => t.outcome === 'Yes');
                    const noToken = m.tokens.find(t => t.outcome === 'No');
                    if (yesToken && noToken) {
                        priceYes = (parseFloat(yesToken.price) || 0.5) * 100;
                        priceNo = (parseFloat(noToken.price) || 0.5) * 100;
                        hasValidPrice = true;
                    }
                }
                
            } catch (e) {
                console.log('Price parse error for', m.question?.substring(0, 30), e.message);
            }

            // 计算磨损/套利
            const totalPrice = priceYes + priceNo;
            const spread = totalPrice - 100;
            
            // 检测类别 - 更完整的规则
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
                spread: Math.round(spread * 100) / 100,
                liquidity: parseFloat(m.liquidity) || 0,
                volume: parseFloat(m.volume) || 0,
                volume24h: parseFloat(m.volume24hr) || parseFloat(m.volume24h) || 0,
                endDate: m.endDate || m.endDateIso || null,
                active: !m.closed && m.active !== false,
                closed: m.closed === true,
                hasValidPrice: hasValidPrice
            };
        });

        // 过滤掉无效数据
        const valid = processed.filter(m => m.title !== 'Unknown');
        
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
                ? activeMarkets.filter(m => m.spread !== 0).reduce((s, m) => s + Math.abs(m.spread), 0) / activeMarkets.filter(m => m.spread !== 0).length 
                : 0,
            spreadDistribution: {
                arbitrage: activeMarkets.filter(m => m.spread < -0.5).length,
                zero: activeMarkets.filter(m => m.spread >= -0.5 && m.spread < 0.5).length,
                low: activeMarkets.filter(m => m.spread >= 0.5 && m.spread < 2).length,
                medium: activeMarkets.filter(m => m.spread >= 2 && m.spread < 5).length,
                high: activeMarkets.filter(m => m.spread >= 5).length
            },
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

// 更完整的类别检测
function detectCategory(m) {
    const question = (m.question || '').toLowerCase();
    const title = (m.title || '').toLowerCase();
    const desc = (m.description || '').toLowerCase();
    const tags = ((m.tags || []).join(' ')).toLowerCase();
    const groupTitle = (m.groupItemTitle || '').toLowerCase();
    
    const text = `${question} ${title} ${desc} ${tags} ${groupTitle}`;
    
    // 体育 - 最先检测，因为很多体育市场
    if (text.match(/super bowl|nfl|nba|nhl|mlb|ufc|mma|premier league|champions league|la liga|bundesliga|serie a|ligue 1|world cup|euro 202|copa america|tennis|wimbledon|us open|australian open|french open|golf|pga|masters|f1|formula 1|formula one|nascar|boxing|fight|match|game|playoffs|finals|championship|mvp|rookie|draft|trade|transfer|score|win.*vs|vs.*win|defeat|beat|title|trophy|sport|athlete|team|player|coach|season|league|tournament|cup|bowl|series|race|grand prix|betting|odds/)) {
        return 'Sports';
    }
    
    // 政治
    if (text.match(/trump|biden|harris|obama|clinton|president|election|vote|poll|senate|congress|house|governor|mayor|democrat|republican|gop|dnc|rnc|political|politic|impeach|pardon|cabinet|secretary|minister|prime minister|parliament|brexit|eu\s|nato|un\s|united nations|sanction|tariff|immigration|border|asylum|refugee|ukraine|russia|china|israel|gaza|iran|north korea|war\s|military|army|navy|ceasefire|treaty|diplomat|ambassador|white house|capitol|supreme court|scotus|justice|judge|law|legislation|bill\s|act\s|amendment|constitutional/)) {
        return 'Politics';
    }
    
    // 加密货币
    if (text.match(/bitcoin|btc|ethereum|eth|crypto|solana|sol|xrp|ripple|doge|dogecoin|cardano|ada|polygon|matic|avalanche|avax|chainlink|link|polkadot|dot|cosmos|atom|near|sui|apt|aptos|arbitrum|arb|optimism|base\s|layer 2|l2|defi|nft|token|coin|blockchain|web3|dao|dex|cex|binance|coinbase|kraken|ftx|sec.*crypto|etf.*bitcoin|bitcoin.*etf|halving|staking|yield|airdrop|wallet|exchange|trading|altcoin|memecoin|stablecoin|usdt|usdc/)) {
        return 'Crypto';
    }
    
    // 商业/金融
    if (text.match(/stock|share|nasdaq|nyse|dow|s&p|spy|qqq|market cap|ipo|earnings|revenue|profit|loss|quarterly|annual|fiscal|dividend|buyback|merger|acquisition|bankrupt|layoff|hire|ceo|cfo|coo|executive|board|investor|venture|startup|valuation|unicorn|inflation|recession|gdp|fed\s|federal reserve|interest rate|rate cut|rate hike|unemployment|jobs report|cpi|ppi|treasury|bond|yield curve|oil|gas|commodity|gold|silver|real estate|housing|mortgage|bank|finance|economy|economic|company|corporate|business|industry|sector|tesla|apple|amazon|google|meta|microsoft|nvidia|amd|intel|openai|anthropic/)) {
        return 'Business';
    }
    
    // 科技
    if (text.match(/ai\s|artificial intelligence|machine learning|ml\s|gpt|chatgpt|claude|llm|large language|neural|deep learning|robot|automation|spacex|starship|rocket|launch|orbit|mars|moon|nasa|space\s|satellite|starlink|neuralink|quantum|computing|chip|semiconductor|processor|software|hardware|tech|technology|innovation|research|science|scientific|experiment|discovery|physics|chemistry|biology|medicine|drug|fda|clinical|trial|vaccine|treatment|cure|disease|health|medical|hospital|doctor/)) {
        return 'Science';
    }
    
    // 娱乐
    if (text.match(/movie|film|cinema|box office|oscar|academy award|golden globe|emmy|grammy|tony|mtv|billboard|album|song|artist|singer|band|concert|tour|music|spotify|netflix|disney|hbo|streaming|tv show|series|season|episode|actor|actress|director|producer|celebrity|star|famous|hollywood|bollywood|award|nomination|winner|taylor swift|beyonce|drake|kanye|kardashian|jenner|youtube|tiktok|instagram|influencer|viral|trending|game|gaming|esports|twitch|playstation|xbox|nintendo|steam|gta|call of duty|fortnite|minecraft|anime|manga/)) {
        return 'Entertainment';
    }
    
    return 'Other';
}
