const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseFollowerCount,
  parseYouTubeSubscriberCount,
  extractInstagramHandle,
  sortByFollowersDesc,
} = require('../services/influencerMapper');
const {
  sanitizeCreatorForPlatform,
  urlHostMatchesPlatform,
} = require('../services/platformConfig');
const {
  parseGroqResponse,
  dedupeByHandle,
  buildSourceBlocks,
} = require('../services/groqExtractCreators');
const { isInstagramProfileUrl } = require('../services/anakinUrlScraper');
const {
  decodeDuckDuckGoRedirect,
  parseDuckDuckGoMarkdown,
  buildSerpUrl,
  buildSearchQuery,
} = require('../services/anakinSerpSearch');
const {
  mapWireDataToCreators,
  mapYouTubeWireToCreators,
  scoreYouTubeVideo,
  extractCreatorFromRecord,
  buildDiscoveryQuery,
} = require('../services/anakinWire');

test('parseFollowerCount handles k/m/b suffixes and plain numbers', () => {
  assert.equal(parseFollowerCount('1.2M followers'), 1_200_000);
  assert.equal(parseFollowerCount('250k followers worldwide'), 250_000);
  assert.equal(parseFollowerCount('650m followers'), 650_000_000);
  assert.equal(parseFollowerCount('1,250 followers'), 1_250);
  assert.equal(parseFollowerCount('no number here'), null);
  assert.equal(parseFollowerCount(undefined), null);
});

test('parseFollowerCount handles "Followers <num>" ordering and bold markup', () => {
  assert.equal(
    parseFollowerCount('@simrun.chopra **Instagram Followers ** 862.3K'),
    862_300,
  );
  assert.equal(parseFollowerCount('Followers: 12.1M'), 12_100_000);
  assert.equal(parseFollowerCount('Subscribers — 5.5m'), 5_500_000);
});

test('extractInstagramHandle prefers profile URLs over @mentions', () => {
  assert.equal(
    extractInstagramHandle('https://www.instagram.com/cristiano/', 'Cristiano'),
    'cristiano',
  );
  assert.equal(
    extractInstagramHandle('https://example.com/article', 'Foo (@bar.baz)'),
    'bar.baz',
  );
  assert.equal(extractInstagramHandle('https://instagram.com/p/abc/', ''), null);
});

test('sortByFollowersDesc puts nulls last and largest first', () => {
  const sorted = sortByFollowersDesc([
    { handle: 'a', followerCount: null },
    { handle: 'b', followerCount: 10_000 },
    { handle: 'c', followerCount: 500_000 },
    { handle: 'd', followerCount: null },
  ]);
  assert.deepEqual(
    sorted.map((r) => r.handle),
    ['c', 'b', 'a', 'd'],
  );
});

test('parseGroqResponse drops invalid handles and tolerates code fences', () => {
  const raw = '```json\n{"creators":[{"handle":"@valid_one","displayName":"Valid","followerText":"1.2M","evidenceSnippet":"Snippet","sourceUrl":"https://example.com"},{"handle":"bad handle!","evidenceSnippet":"x","sourceUrl":"y"}]}\n```';
  const out = parseGroqResponse(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].handle, 'valid_one');
  assert.equal(out[0].displayName, 'Valid');
  assert.equal(out[0].followerText, '1.2M');
});

test('parseGroqResponse returns [] on non-JSON input', () => {
  assert.deepEqual(parseGroqResponse('sorry, i cannot help with that'), []);
  assert.deepEqual(parseGroqResponse(''), []);
});

test('dedupeByHandle keeps first occurrence (case-insensitive)', () => {
  const out = dedupeByHandle([
    { handle: 'foo', displayName: 'First' },
    { handle: 'FOO', displayName: 'Second' },
    { handle: 'bar', displayName: 'Third' },
  ]);
  assert.deepEqual(out.map((c) => c.displayName), ['First', 'Third']);
});

test('decodeDuckDuckGoRedirect unwraps /l/?uddg=… real URLs', () => {
  assert.equal(
    decodeDuckDuckGoRedirect(
      'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.famekeeda.com%2Fblogs%2Ftop%2Dfitness%2Dinfluencers%2Din%2Dindia%2F&rut=abc',
    ),
    'https://www.famekeeda.com/blogs/top-fitness-influencers-in-india/',
  );
  assert.equal(
    decodeDuckDuckGoRedirect('https://example.com/article'),
    'https://example.com/article',
  );
});

test('parseDuckDuckGoMarkdown extracts {title,url,snippet} and skips junk', () => {
  const md =
    '## [Top Fitness Influencers in India 2025 - Fame Keeda]' +
    '(https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.famekeeda.com%2Fblogs%2Ftop%2Dfitness%2Dinfluencers%2Din%2Dindia%2F&rut=abc)\n\n' +
    'Fame Keeda lists the top 25 Indian fitness creators on Instagram with handles and follower counts.\n\n' +
    '## [www.modash.io/find-influencers/india/fitness]' +
    '(https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.modash.io%2Ffind%2Dinfluencers%2Findia%2Ffitness&rut=def)\n\n' +
    '[Top 20 Indian Fitness Influencers on Instagram (Apr 2026) - Modash]' +
    '(https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.modash.io%2Ffind%2Dinfluencers%2Findia%2Ffitness&rut=def)\n\n' +
    'A curated list of fitness creators based in India with handles and audience analytics.';

  const out = parseDuckDuckGoMarkdown(md, { limit: 5 });
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'Top Fitness Influencers in India 2025 - Fame Keeda');
  assert.equal(out[0].url, 'https://www.famekeeda.com/blogs/top-fitness-influencers-in-india/');
  assert.match(out[0].snippet, /top 25 Indian fitness creators/);

  assert.equal(out[1].title, 'Top 20 Indian Fitness Influencers on Instagram (Apr 2026) - Modash');
  assert.equal(out[1].url, 'https://www.modash.io/find-influencers/india/fitness');
});

test('buildSerpUrl + buildSearchQuery produce a usable DDG HTML URL', () => {
  const q = buildSearchQuery({ niche: 'fitness', location: 'India' });
  assert.match(q, /instagram/i);
  assert.match(q, /fitness/i);
  assert.match(q, /India/);
  const url = buildSerpUrl(q);
  assert.match(url, /^https:\/\/html\.duckduckgo\.com\/html\/\?q=/);
});

test('buildSourceBlocks prefers STRUCTURED_JSON from Anakin over huge markdown', () => {
  const searchResults = [
    {
      url: 'https://example.com/article',
      title: 'Top creators',
      snippet: 'Short snippet',
    },
  ];
  const longMarkdown = 'Z'.repeat(6000);
  const scrapedArticles = [
    {
      url: 'https://example.com/article',
      markdown: longMarkdown,
      generatedJson: {
        status: 'success',
        data: {
          mentions: [{ handle: 'creator_one', followers: '250k' }],
        },
      },
    },
  ];
  const out = buildSourceBlocks(searchResults, scrapedArticles);
  assert.match(out, /STRUCTURED_JSON/);
  assert.match(out, /creator_one/);
  assert.ok(!out.includes('ZZZZZZ'));
});

test('scoreYouTubeVideo penalises meta commentary titles', () => {
  const q = { niche: 'Fitness' };
  const meta = scoreYouTubeVideo(
    { title: 'Ranking Indian Fitness Influencer (10-1)', channel: 'Commentary Hub' },
    q,
  );
  const creator = scoreYouTubeVideo(
    { title: 'Full body workout at home', channel: 'Yash Sharma Fitness' },
    q,
  );
  assert.ok(creator > meta);
});

test('mapYouTubeWireToCreators dedupes by channel_id', () => {
  const wireData = {
    data: {
      data: [
        {
          channel_id: 'UCabc123',
          channel: 'Fit Channel',
          title: 'Best fitness tips',
          url: 'https://www.youtube.com/watch?v=1',
          views: '100K views',
        },
        {
          channel_id: 'UCabc123',
          channel: 'Fit Channel',
          title: 'Another video',
          url: 'https://www.youtube.com/watch?v=2',
        },
      ],
    },
  };
  const creators = mapYouTubeWireToCreators(wireData, 10);
  assert.equal(creators.length, 1);
  assert.equal(creators[0].handle, 'UCabc123');
  assert.equal(creators[0].platform, 'youtube');
});

test('mapWireDataToCreators extracts nested Instagram handles', () => {
  const data = {
    results: [
      { username: 'fit_creator', full_name: 'Fit Creator', followers_count: 120000 },
      { profile_url: 'https://instagram.com/yoga_guru/', follower_count: 45000 },
    ],
  };
  const creators = mapWireDataToCreators(data, 10);
  assert.equal(creators.length, 2);
  assert.equal(creators[0].handle, 'fit_creator');
  assert.equal(creators[1].handle, 'yoga_guru');
});

test('extractCreatorFromRecord ignores invalid handles', () => {
  assert.equal(extractCreatorFromRecord({ username: 'p' }), null);
  assert.equal(
    extractCreatorFromRecord({ url: 'https://instagram.com/valid_user/' })?.handle,
    'valid_user',
  );
});

test('buildDiscoveryQuery joins niche, location, and audience', () => {
  const q = buildDiscoveryQuery({
    niche: 'Fitness',
    location: 'Bangalore',
    audienceType: 'Gen Z',
  });
  assert.match(q, /Fitness/);
  assert.match(q, /Bangalore/);
  assert.match(q, /instagram creators/i);
});

test('parseYouTubeSubscriberCount parses subscribers and rejects views context', () => {
  assert.equal(parseYouTubeSubscriberCount('1.2M subscribers').count, 1_200_000);
  assert.equal(parseYouTubeSubscriberCount('Subscribers\n862K').count, 862_000);
  assert.equal(parseYouTubeSubscriberCount('100K views only').count, null);
  assert.equal(
    parseYouTubeSubscriberCount('About\n1.2M subscribers\nVideos').count,
    1_200_000,
  );
});

test('sanitizeCreatorForPlatform drops wrong-host Instagram URLs on YouTube', () => {
  const bad = sanitizeCreatorForPlatform(
    {
      handle: 'creator',
      profileUrl: 'https://instagram.com/creator/',
      platform: 'youtube',
    },
    'youtube',
  );
  assert.equal(bad, null);

  const ok = sanitizeCreatorForPlatform(
    {
      handle: 'UCabc',
      channelId: 'UCabc',
      profileUrl: 'https://www.youtube.com/channel/UCabc',
      platform: 'youtube',
    },
    'youtube',
  );
  assert.equal(ok.platform, 'youtube');
  assert.equal(urlHostMatchesPlatform(ok.profileUrl, 'youtube'), true);
});

test('isInstagramProfileUrl recognises profile pages but not posts/reels', () => {
  assert.equal(isInstagramProfileUrl('https://www.instagram.com/cristiano/'), true);
  assert.equal(isInstagramProfileUrl('https://instagram.com/cristiano'), true);
  assert.equal(isInstagramProfileUrl('https://www.instagram.com/p/abc123/'), false);
  assert.equal(isInstagramProfileUrl('https://www.instagram.com/reel/abc/'), false);
  assert.equal(isInstagramProfileUrl('https://example.com/article'), false);
  assert.equal(isInstagramProfileUrl(''), false);
});
