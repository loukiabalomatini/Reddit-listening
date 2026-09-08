export type RedditItem = {
  id: string;
  title: string;
  text: string;
  author: string;
  subreddit: string;
  createdAt: string;
  url: string;
  score: number;
};

type RedditToken = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

let cachedToken: { value: string; expiresAt: number } | null = null;

function decode(value: string) {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function field(entry: string, tag: string) {
  return decode(entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '');
}

function userAgent() {
  return process.env.REDDIT_USER_AGENT || 'web:reddit-listening:v1.0 (by /u/reddit-listening)';
}

async function getOAuthToken() {
  const directToken = process.env.REDDIT_ACCESS_TOKEN?.trim();
  if (directToken) return directToken;

  const clientId = process.env.REDDIT_CLIENT_ID?.trim();
  const clientSecret = process.env.REDDIT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent()
    },
    body: 'grant_type=client_credentials'
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Reddit OAuth token request returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }

  const token = (await response.json()) as RedditToken;
  cachedToken = {
    value: token.access_token,
    expiresAt: Date.now() + Math.max(60, token.expires_in || 3600) * 1000
  };
  return cachedToken.value;
}

async function fetchViaApi(limit: number): Promise<RedditItem[]> {
  const token = await getOAuthToken();
  if (!token) throw new Error('Reddit API credentials are not configured');

  const url = new URL('https://oauth.reddit.com/r/all/new');
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 25), 100)));
  url.searchParams.set('raw_json', '1');

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': userAgent()
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Reddit API returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }

  const json = await response.json() as { data?: { children?: Array<{ data?: Record<string, any> }> } };
  return (json.data?.children || []).map(({ data = {} }) => ({
    id: String(data.id || ''),
    title: String(data.title || ''),
    text: String(data.selftext || ''),
    author: String(data.author || 'unknown'),
    subreddit: String(data.subreddit || 'unknown'),
    createdAt: data.created_utc ? new Date(Number(data.created_utc) * 1000).toISOString() : new Date().toISOString(),
    url: data.permalink ? `https://www.reddit.com${data.permalink}` : String(data.url || ''),
    score: Number(data.score || 0)
  })).filter(item => item.id && item.url);
}

async function fetchViaRss(limit: number): Promise<RedditItem[]> {
  const url = new URL('https://www.reddit.com/r/all/new/.rss');
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 25), 100)));

  const response = await fetch(url, {
    headers: {
      Accept: 'application/atom+xml, application/rss+xml;q=0.9, text/xml;q=0.8',
      'User-Agent': userAgent()
    }
  });

  if (!response.ok) throw new Error(`Reddit RSS returned ${response.status}`);

  const xml = await response.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)];
  return entries.map(match => {
    const entry = match[1];
    const url = entry.match(/<link[^>]+href="([^"]+)"/i)?.[1] || '';
    const id = field(entry, 'id') || url;
    const category = entry.match(/<category[^>]+term="([^"]+)"/i)?.[1] || '';
    return {
      id,
      title: field(entry, 'title'),
      text: field(entry, 'content') || field(entry, 'summary'),
      author: field(entry, 'name') || 'unknown',
      subreddit: category.replace(/^r\//i, '') || 'unknown',
      createdAt: field(entry, 'updated') || field(entry, 'published') || new Date().toISOString(),
      url,
      score: 0
    };
  }).filter(item => item.id && item.url);
}

/** Global Reddit ingestion stream: OAuth Data API first, RSS only as temporary fallback. */
export async function fetchNewReddit(limit = 100): Promise<RedditItem[]> {
  try {
    const items = await fetchViaApi(limit);
    console.log(`Reddit API ingestion: ${items.length} items fetched from r/all/new`);
    return items;
  } catch (apiError) {
    if (process.env.REDDIT_ALLOW_RSS_FALLBACK === 'false') throw apiError;
    console.warn(`Reddit API ingestion unavailable: ${apiError instanceof Error ? apiError.message : String(apiError)}`);
    const items = await fetchViaRss(limit);
    console.log(`Reddit RSS fallback: ${items.length} items fetched from r/all/new`);
    return items;
  }
}

export async function searchReddit(_query: string, limit = 25): Promise<RedditItem[]> {
  return fetchNewReddit(limit);
}
