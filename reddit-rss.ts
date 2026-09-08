export async function fetchRedditRss(subreddit: string, limit = 50) {
  const name = subreddit.replace(/^r\//i, '').trim();
  const url = `https://www.reddit.com/r/${encodeURIComponent(name)}/new/.rss?limit=${limit}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': process.env.REDDIT_USER_AGENT || 'RedditListening/1.0' }
  });
  if (!response.ok) throw new Error(`Reddit RSS returned ${response.status}`);
  const xml = await response.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(match => {
    const entry = match[1];
    const get = (tag: string) => entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1]
      ?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() || '';
    return { title: get('title'), content: get('content'), author: get('name'), updated: get('updated'), url: entry.match(/<link[^>]+href="([^"]+)"/i)?.[1] || '' };
  });
}
