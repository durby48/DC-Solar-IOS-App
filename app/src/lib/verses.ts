/**
 * Verse of the day — encouragement for hard workers.
 * Shown on the sign-in screen instead of a static tagline.
 *
 * Wording follows public-domain translations (World English Bible / KJV),
 * lightly modernized. The day's verse is deterministic: everyone on the crew
 * sees the same verse on the same day, rotating through the whole library.
 */

export interface Verse {
  text: string;
  reference: string;
}

export const VERSES: Verse[] = [
  {
    text: 'Whatever you do, work heartily, as for the Lord and not for men.',
    reference: 'Colossians 3:23',
  },
  {
    text: 'In all hard work there is profit, but mere talk leads only to poverty.',
    reference: 'Proverbs 14:23',
  },
  {
    text: 'Let us not be weary in doing good, for we will reap in due season if we don’t give up.',
    reference: 'Galatians 6:9',
  },
  {
    text: 'I can do all things through Christ who strengthens me.',
    reference: 'Philippians 4:13',
  },
  {
    text: 'Commit your work to the Lord, and your plans will succeed.',
    reference: 'Proverbs 16:3',
  },
  {
    text: 'Let the favor of the Lord our God be on us; establish the work of our hands.',
    reference: 'Psalm 90:17',
  },
  {
    text: 'Whatever your hand finds to do, do it with your might.',
    reference: 'Ecclesiastes 9:10',
  },
  {
    text: 'Do you see a man skilled in his work? He will serve before kings.',
    reference: 'Proverbs 22:29',
  },
  {
    text: 'Be steadfast, immovable, always abounding in the Lord’s work, knowing that your labor is not in vain.',
    reference: '1 Corinthians 15:58',
  },
  {
    text: 'He who works his land will have plenty of bread.',
    reference: 'Proverbs 12:11',
  },
  {
    text: 'The desires of the diligent are fully satisfied.',
    reference: 'Proverbs 13:4',
  },
  {
    text: 'The plans of the diligent surely lead to profit.',
    reference: 'Proverbs 21:5',
  },
  {
    text: 'And you, brothers, do not grow weary in doing what is right.',
    reference: '2 Thessalonians 3:13',
  },
  {
    text: 'Those who wait for the Lord will renew their strength. They will run and not be weary; they will walk and not faint.',
    reference: 'Isaiah 40:31',
  },
  {
    text: 'Let your light shine before men, that they may see your good works and glorify your Father in heaven.',
    reference: 'Matthew 5:16',
  },
  {
    text: 'Lazy hands make for poverty, but the hand of the diligent brings wealth.',
    reference: 'Proverbs 10:4',
  },
  {
    text: 'You will eat the fruit of the labor of your hands. You will be happy, and it will be well with you.',
    reference: 'Psalm 128:2',
  },
  {
    text: 'Be strong and courageous. Do not be afraid, for the Lord your God himself goes with you.',
    reference: 'Deuteronomy 31:6',
  },
  {
    text: 'Be strong and courageous. Do not be dismayed, for the Lord your God is with you wherever you go.',
    reference: 'Joshua 1:9',
  },
  {
    text: 'Trust in the Lord with all your heart. In all your ways acknowledge him, and he will make your paths straight.',
    reference: 'Proverbs 3:5–6',
  },
  {
    text: 'Blessed is the one who perseveres under trial, for he will receive the crown of life.',
    reference: 'James 1:12',
  },
  {
    text: 'Do not be lagging in diligence; be fervent in spirit, serving the Lord.',
    reference: 'Romans 12:11',
  },
  {
    text: 'That everyone may eat and drink and find satisfaction in all his labor — this is the gift of God.',
    reference: 'Ecclesiastes 3:13',
  },
  {
    text: 'Go to the ant, consider her ways, and be wise — she prepares her bread in the summer.',
    reference: 'Proverbs 6:6–8',
  },
  {
    text: 'But you, be strong! Do not let your hands be weak, for your work will be rewarded.',
    reference: '2 Chronicles 15:7',
  },
  {
    text: 'Now therefore, God, strengthen my hands.',
    reference: 'Nehemiah 6:9',
  },
  {
    text: 'This is the day that the Lord has made. We will rejoice and be glad in it!',
    reference: 'Psalm 118:24',
  },
  {
    text: 'Come to me, all you who labor and are heavy burdened, and I will give you rest.',
    reference: 'Matthew 11:28',
  },
  {
    text: 'Make it your ambition to lead a quiet life, to mind your own business, and to work with your own hands.',
    reference: '1 Thessalonians 4:11',
  },
  {
    text: 'For we are his workmanship, created in Christ Jesus for good works.',
    reference: 'Ephesians 2:10',
  },
  {
    text: 'He who began a good work in you will carry it on to completion.',
    reference: 'Philippians 1:6',
  },
  {
    text: 'Commit your way to the Lord. Trust in him, and he will act.',
    reference: 'Psalm 37:5',
  },
  {
    text: 'Prepare your work outside and get your fields ready; afterwards, build your house.',
    reference: 'Proverbs 24:27',
  },
  {
    text: 'He who is faithful in very little is faithful also in much.',
    reference: 'Luke 16:10',
  },
  {
    text: 'Well done, good and faithful servant. You have been faithful over a few things; I will set you over many things.',
    reference: 'Matthew 25:21',
  },
  {
    text: 'The Lord God took the man and put him in the garden of Eden to work it and keep it.',
    reference: 'Genesis 2:15',
  },
  {
    text: 'The sleep of a laboring man is sweet.',
    reference: 'Ecclesiastes 5:12',
  },
  {
    text: 'Do not be afraid, for I am with you. I will strengthen you; yes, I will help you.',
    reference: 'Isaiah 41:10',
  },
  {
    text: 'I lift up my eyes to the hills. Where does my help come from? My help comes from the Lord.',
    reference: 'Psalm 121:1–2',
  },
  {
    text: 'God is not unjust; he will not forget your work and the love you have shown him.',
    reference: 'Hebrews 6:10',
  },
  {
    text: 'Two are better than one, because they have a good reward for their labor.',
    reference: 'Ecclesiastes 4:9',
  },
  {
    text: 'Whether you eat or drink, or whatever you do, do it all to the glory of God.',
    reference: '1 Corinthians 10:31',
  },
];

/**
 * The verse for a given date (defaults to today), stable for the whole day
 * and the same for the whole crew: days-since-epoch modulo library size.
 */
export function verseOfTheDay(date: Date = new Date()): Verse {
  const daysSinceEpoch = Math.floor(
    (date.getTime() - date.getTimezoneOffset() * 60_000) / 86_400_000,
  );
  return VERSES[((daysSinceEpoch % VERSES.length) + VERSES.length) % VERSES.length];
}
