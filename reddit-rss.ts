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

function decode(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
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

/**
 * Read Reddit's global newest-post RSS feed.
 *
 * This intentionally avoids Reddit's search endpoint. The worker downloads
 * the newest global posts once per polling cycle and applies monitor rules
 * locally, which gives us one ingestion stream instead of one Reddit request
 * per keyword.
 */
export async function fetchNewReddit(limit = 100): Promise<RedditItem[]> {
  const url = new URL('https://www.reddit.com/r/all/new/.rss');
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 25), 100)));

  const response = await fetch(url, {
    headers: {
      Accept: 'application/atom+xml, application/rss+xml;q=0.9, text/xml;q=0.8',
      'User-Agent': process.env.REDDIT_USER_AGENT || 'RedditListening/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Reddit global RSS returned ${response.status}`);
  }

  const xml = await response.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)];

  return entries.map((match) => {
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
  }).filter((item) => item.id && item.url);
}

/**
 * Backwards-compatible name for callers that still import searchReddit.
 * The query is no longer sent to Reddit; filtering happens in the monitor
 * layer so every active monitor sees the same global ingestion stream.
 */
export async function searchReddit(_query: string, limit = 25): Promise<RedditItem[]> {
  return fetchNewReddit(limit);
}
