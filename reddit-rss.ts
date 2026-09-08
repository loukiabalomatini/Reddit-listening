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

/** Global Reddit search feed, newest first. No Reddit API app is required. */
export async function searchReddit(query: string, limit = 25): Promise<RedditItem[]> {
  const url = new URL('https://www.reddit.com/search.rss');
  url.searchParams.set('q', query);
  url.searchParams.set('sort', 'new');
  url.searchParams.set('limit', String(Math.min(limit, 25)));

  const response = await fetch(url, {
    headers: { 'User-Agent': process.env.REDDIT_USER_AGENT || 'RedditListening/1.0' }
  });
  if (!response.ok) throw new Error(`Reddit RSS returned ${response.status}`);

  const xml = await response.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => {
    const entry = match[1];
    const url = entry.match(/<link[^>]+href="([^"]+)"/i)?.[1] || '';
    return {
      id: field(entry, 'id') || url,
      title: field(entry, 'title'),
      text: field(entry, 'content'),
      author: field(entry, 'name') || 'unknown',
      subreddit: entry.match(/<category[^>]+term="([^"]+)"/i)?.[1] || 'unknown',
      createdAt: field(entry, 'updated') || new Date().toISOString(),
      url,
      score: 0
    };
  });
}
