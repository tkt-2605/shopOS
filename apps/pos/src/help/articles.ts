/*
 * How to put right what goes wrong, for the person at the counter.
 *
 * In the app, not on a website, so they open with the line down -- which is
 * when a shop most needs them. Short steps a shopkeeper follows with a
 * customer waiting; button names stay in English because the buttons are.
 * Each article matches a runbook in `docs/support/runbooks/`, which is the
 * same problem from support's side.
 *
 * The Tamil is a first draft and wants reading by a native speaker before a
 * release (`helpArticles.test.ts` keeps the two languages step for step).
 */

export type Lang = 'en' | 'ta'

export interface Article {
  id: string
  title: Record<Lang, string>
  steps: Record<Lang, string[]>
  /** Extra words people search with. */
  words: string[]
  /** The same problem from support's side, in `docs/support/runbooks/`. */
  runbook?: string
}

export const ARTICLES: Article[] = [
  {
    id: 'paid-twice',
    runbook: 'paid-twice',
    words: ['payment', 'double', 'cancel', 'credit', 'account'],
    title: {
      en: 'A bill or account was paid twice',
      ta: 'ஒரு பில் அல்லது கணக்கு இரண்டு முறை செலுத்தப்பட்டுள்ளது',
    },
    steps: {
      en: [
        'Open Needs Attention. It lists both payments, with the counter and the time of each.',
        'Ask the customer whether they really paid twice. If they did, press Clear: the extra stays on their account.',
        'If they paid once, press Cancel this payment on the one that did not happen, then Yes, go ahead.',
        'You can also do it from Credit: open the customer\'s account and press Cancel payment.',
      ],
      ta: [
        'Needs Attention பக்கத்தைத் திறக்கவும். இரண்டு பணம் செலுத்துதல்களும், ஒவ்வொன்றின் கவுண்டர் மற்றும் நேரத்துடன் காட்டப்படும்.',
        'வாடிக்கையாளர் உண்மையில் இரண்டு முறை செலுத்தினாரா என்று கேளுங்கள். ஆம் என்றால் Clear அழுத்தவும்: கூடுதல் தொகை அவர் கணக்கில் இருக்கும்.',
        'ஒரு முறை மட்டுமே செலுத்தியிருந்தால், நடக்காத ஒன்றில் Cancel this payment அழுத்தி, பிறகு Yes, go ahead அழுத்தவும்.',
        'Credit பக்கத்திலும் செய்யலாம்: வாடிக்கையாளரின் கணக்கைத் திறந்து Cancel payment அழுத்தவும்.',
      ],
    },
  },
  {
    id: 'refunded-twice',
    runbook: 'refunded-twice',
    words: ['return', 'refund', 'double', 'cancel'],
    title: {
      en: 'Goods were taken back twice',
      ta: 'பொருட்கள் இரண்டு முறை திரும்பப் பெறப்பட்டுள்ளன',
    },
    steps: {
      en: [
        'Needs Attention lists the returns, with the counter and the time of each.',
        'Ask whether the goods really came back twice. Almost always they did not.',
        'Press Cancel this return on the one that did not happen. Its refund, credit note and points go back with it.',
        'Count the cash drawer: money paid out twice in cash has to be asked back from the customer.',
      ],
      ta: [
        'Needs Attention பக்கம் திருப்பிப் பெறுதல்களை, ஒவ்வொன்றின் கவுண்டர் மற்றும் நேரத்துடன் காட்டும்.',
        'பொருட்கள் உண்மையில் இரண்டு முறை திரும்பி வந்தனவா என்று பாருங்கள். பெரும்பாலும் வந்திருக்காது.',
        'நடக்காத ஒன்றில் Cancel this return அழுத்தவும். அதன் பணத் திருப்பம், கிரெடிட் நோட், புள்ளிகள் அனைத்தும் திரும்பப் போய்விடும்.',
        'கேஷ் டிராயரை எண்ணுங்கள்: பணமாக இரண்டு முறை கொடுத்திருந்தால், அதை வாடிக்கையாளரிடம் திரும்பக் கேட்க வேண்டும்.',
      ],
    },
  },
  {
    id: 'billing-held',
    runbook: 'restored-from-backup',
    words: ['restore', 'backup', 'held', 'cannot bill', 'bill anyway'],
    title: {
      en: 'The till says billing is held',
      ta: 'பில்லிங் நிறுத்தி வைக்கப்பட்டுள்ளது என்று டில் சொல்கிறது',
    },
    steps: {
      en: [
        'This till was restored from a backup and has not caught up with the other tills yet.',
        'Switch on the main till and make sure both are on the shop\'s network. Leave this till open for a few minutes; the hold lifts by itself.',
        'Press Bill anyway only if no bill was made on any till since the backup was taken. Otherwise two customers can get the same bill number.',
      ],
      ta: [
        'இந்த டில் ஒரு பேக்கப்பிலிருந்து மீட்டெடுக்கப்பட்டது; மற்ற டில்களுடன் இன்னும் ஒத்துப்போகவில்லை.',
        'முதன்மை டில்லை (main till) இயக்கி, இரண்டும் கடையின் நெட்வொர்க்கில் உள்ளனவா என்று பாருங்கள். சில நிமிடங்கள் இந்த டில்லைத் திறந்து வைத்தால், தானாகவே சரியாகும்.',
        'பேக்கப் எடுத்த பிறகு எந்த டில்லிலும் பில் போடப்படவில்லை என்றால் மட்டுமே Bill anyway அழுத்தவும். இல்லையென்றால் இரண்டு வாடிக்கையாளர்களுக்கு ஒரே பில் எண் கிடைக்கலாம்.',
      ],
    },
  },
  {
    id: 'change-counter',
    runbook: 'counter-claimed-by-dead-till',
    words: ['counter', 'register', 'use here', 'free', 'hand over'],
    title: {
      en: 'Changing which counter a till bills on',
      ta: 'ஒரு டில் எந்த கவுண்டரில் பில் போடுகிறது என்பதை மாற்றுதல்',
    },
    steps: {
      en: [
        'Open Counters and press Use here on the counter this machine sits at.',
        'The main till must be on. A till that still holds bills the main has not got is asked to hand them over first; leave it open until it has.',
        'If a counter is held by a till that is gone for good, press Free them on Settings, or ask support for a fix.',
      ],
      ta: [
        'Counters பக்கத்தைத் திறந்து, இந்த கணினி இருக்கும் கவுண்டரில் Use here அழுத்தவும்.',
        'முதன்மை டில் இயங்கிக்கொண்டிருக்க வேண்டும். முதன்மை டில்லுக்கு இன்னும் போகாத பில்கள் இந்த டில்லில் இருந்தால், முதலில் அவற்றை ஒப்படைக்கச் சொல்லும்; ஒப்படைக்கும் வரை திறந்து வைக்கவும்.',
        'நிரந்தரமாக இல்லாத ஒரு டில் கவுண்டரைப் பிடித்திருந்தால், Settings-இல் Free them அழுத்தவும், அல்லது சப்போர்ட்டிடம் ஒரு சரிசெய்தலைக் (fix) கேளுங்கள்.',
      ],
    },
  },
  {
    id: 'main-off',
    words: ['main till', 'offline', 'off', 'sync', 'network'],
    title: {
      en: 'When the main till is off',
      ta: 'முதன்மை டில் அணைந்திருக்கும்போது',
    },
    steps: {
      en: [
        'Every counter keeps billing. Nothing is lost.',
        'The counters cannot see each other\'s bills until the main is back, so do not take a payment or a return for the same customer on two counters.',
        'Switch the main back on. The counters catch up by themselves, and anything done twice shows in Needs Attention with a button to cancel it.',
      ],
      ta: [
        'ஒவ்வொரு கவுண்டரும் பில் போடுவதைத் தொடரும். எதுவும் இழக்கப்படாது.',
        'முதன்மை டில் திரும்ப வரும் வரை கவுண்டர்கள் ஒன்றின் பில்களை மற்றொன்று பார்க்க முடியாது. அதனால் ஒரே வாடிக்கையாளரின் பணம் அல்லது திருப்பிப் பெறுதலை இரண்டு கவுண்டர்களில் எடுக்காதீர்கள்.',
        'முதன்மை டில்லை மீண்டும் இயக்குங்கள். கவுண்டர்கள் தானாகவே ஒத்துப்போகும்; இரண்டு முறை நடந்தவை Needs Attention-இல் ரத்து செய்யும் பொத்தானுடன் காட்டப்படும்.',
      ],
    },
  },
  {
    id: 'backups',
    words: ['backup', 'restore', 'pen drive', 'google drive', 'onedrive'],
    title: {
      en: 'Where your backups go',
      ta: 'உங்கள் பேக்கப்புகள் எங்கே போகின்றன',
    },
    steps: {
      en: [
        'ShopOS takes a backup every night at 2 a.m. on each till.',
        'On Settings, Backups, choose a folder off this computer: a pen drive, or a Google Drive or OneDrive folder. A backup only on this computer is lost with it.',
        'To bring a till back from a backup, use Restore on the same screen. With more than one till, joining the new PC to the shop is better: it copies everything from the main.',
      ],
      ta: [
        'ஒவ்வொரு டில்லிலும் இரவு 2 மணிக்கு ShopOS ஒரு பேக்கப் எடுக்கும்.',
        'Settings, Backups-இல் இந்த கணினிக்கு வெளியே ஒரு ஃபோல்டரைத் தேர்ந்தெடுக்கவும்: பென் டிரைவ், அல்லது Google Drive அல்லது OneDrive ஃபோல்டர். இந்த கணினியில் மட்டும் உள்ள பேக்கப், கணினியுடன் சேர்ந்து போய்விடும்.',
        'பேக்கப்பிலிருந்து ஒரு டில்லை மீட்க, அதே திரையில் Restore பயன்படுத்தவும். ஒன்றுக்கு மேற்பட்ட டில்கள் இருந்தால், புதிய கணினியைக் கடையில் சேர்ப்பது நல்லது: அது முதன்மை டில்லிலிருந்து எல்லாவற்றையும் நகலெடுக்கும்.',
      ],
    },
  },
  {
    id: 'forgot-password',
    runbook: 'forgotten-password',
    words: ['password', 'sign in', 'login', 'recovery code', 'locked'],
    title: {
      en: 'Forgot the password',
      ta: 'கடவுச்சொல் மறந்துவிட்டது',
    },
    steps: {
      en: [
        'A cashier\'s password: an owner sets a new one from Staff.',
        'The owner\'s password: press Forgot password? on the sign-in screen and type the recovery code from the paper made when the shop was set up.',
        'The code works once. ShopOS shows a new one: write it down and keep it away from the till.',
        'No code and no other owner: call support.',
      ],
      ta: [
        'காசாளரின் கடவுச்சொல்: உரிமையாளர் Staff பக்கத்திலிருந்து புதியதை அமைக்கலாம்.',
        'உரிமையாளரின் கடவுச்சொல்: உள்நுழைவுத் திரையில் Forgot password? அழுத்தி, கடை அமைக்கும்போது காகிதத்தில் எழுதிய மீட்புக் குறியீட்டை (recovery code) உள்ளிடவும்.',
        'அந்தக் குறியீடு ஒரு முறை மட்டுமே வேலை செய்யும். ShopOS புதிய குறியீட்டைக் காட்டும்: அதை எழுதி, டில்லுக்கு அருகில் இல்லாத இடத்தில் வையுங்கள்.',
        'குறியீடும் இல்லை, வேறு உரிமையாளரும் இல்லை என்றால்: சப்போர்ட்டை அழைக்கவும்.',
      ],
    },
  },
  {
    id: 'getting-help',
    words: ['support', 'whatsapp', 'remote', 'anydesk', 'rustdesk', 'fix', 'send data'],
    title: {
      en: 'Getting help from support',
      ta: 'சப்போர்ட்டிடமிருந்து உதவி பெறுதல்',
    },
    steps: {
      en: [
        'Read out your support code from Get help, or press Message on WhatsApp: the code is already in the message.',
        'If support asks to see the screen, press Start remote help and read them the number it shows. Close it when they are done.',
        'If support asks for the shop\'s records, the owner sends them from Settings, Help, Send my data to support. They are locked so only support can open them.',
        'If support sends a fix, the owner pastes it into Settings, Help, Apply a fix from support. It says what it will change before anything changes.',
      ],
      ta: [
        'Get help-இல் உள்ள உங்கள் சப்போர்ட் குறியீட்டைப் படித்துச் சொல்லுங்கள், அல்லது Message on WhatsApp அழுத்துங்கள்: குறியீடு செய்தியில் ஏற்கனவே இருக்கும்.',
        'சப்போர்ட் திரையைப் பார்க்கக் கேட்டால், Start remote help அழுத்தி, அது காட்டும் எண்ணைச் சொல்லுங்கள். அவர்கள் முடித்ததும் அதை மூடுங்கள்.',
        'சப்போர்ட் கடையின் பதிவுகளைக் கேட்டால், உரிமையாளர் Settings, Help, Send my data to support-இலிருந்து அனுப்பலாம். அவை சப்போர்ட் மட்டுமே திறக்கும்படி பூட்டப்படும்.',
        'சப்போர்ட் ஒரு சரிசெய்தலை (fix) அனுப்பினால், உரிமையாளர் அதை Settings, Help, Apply a fix from support-இல் ஒட்டலாம். எதையும் மாற்றும் முன் அது என்ன மாற்றும் என்று சொல்லும்.',
      ],
    },
  },
  {
    id: 'your-data',
    words: ['privacy', 'data', 'health report', 'cloud', 'delete'],
    title: {
      en: 'Your shop\'s records and ShopOS',
      ta: 'உங்கள் கடையின் பதிவுகளும் ShopOS-உம்',
    },
    steps: {
      en: [
        'Your records stay on your tills. ShopOS does not send them anywhere unless you choose to.',
        'Each till sends ShopOS a daily health report: counts and errors, never a customer, an amount or a password. It is how support knows something is wrong before you call.',
        'Records you send to support are locked so only ShopOS support can open them, and are deleted 30 days after they arrive. Every time support opens them is recorded.',
        'On the Cloud plan, a copy of your records is kept on ShopOS\'s server so your tills can sync from anywhere. Support looks at it only when you ask.',
      ],
      ta: [
        'உங்கள் பதிவுகள் உங்கள் டில்களிலேயே இருக்கும். நீங்கள் தேர்ந்தெடுக்காமல் ShopOS அவற்றை எங்கும் அனுப்பாது.',
        'ஒவ்வொரு டில்லும் தினமும் ShopOS-க்கு ஒரு நிலை அறிக்கையை (health report) அனுப்பும்: எண்ணிக்கைகளும் பிழைகளும் மட்டும்; எந்த வாடிக்கையாளரோ, தொகையோ, கடவுச்சொல்லோ அதில் இருக்காது. நீங்கள் அழைப்பதற்கு முன்பே ஏதாவது தவறு என்று சப்போர்ட் அறிவது இப்படித்தான்.',
        'நீங்கள் சப்போர்ட்டுக்கு அனுப்பும் பதிவுகள் ShopOS சப்போர்ட் மட்டுமே திறக்கும்படி பூட்டப்பட்டு, வந்து சேர்ந்த 30 நாட்களில் நீக்கப்படும். சப்போர்ட் அவற்றைத் திறக்கும் ஒவ்வொரு முறையும் பதிவு செய்யப்படும்.',
        'Cloud திட்டத்தில், உங்கள் டில்கள் எங்கிருந்தும் ஒத்துப்போக, உங்கள் பதிவுகளின் நகல் ShopOS சர்வரில் வைக்கப்படும். நீங்கள் கேட்கும்போது மட்டுமே சப்போர்ட் அதைப் பார்க்கும்.',
      ],
    },
  },
]

/** Articles whose title, steps or extra words hold every word typed, in either language. */
export function searchArticles(query: string, lang: Lang): Article[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ARTICLES
  return ARTICLES.filter((a) => {
    const text = [a.title.en, a.title.ta, ...a.steps.en, ...a.steps[lang], ...a.words].join(' ').toLowerCase()
    return words.every((w) => text.includes(w))
  })
}
