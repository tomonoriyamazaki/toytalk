export const MODEL_MAP = {
  OpenAI: {
    label: "OpenAI",
    desc: "4o-mini-tts",
    defaultVoice: "nova",
    voices: {
      alloy: { label: "Alloy – neutral male", vendorId: "alloy" },
      nova: { label: "Nova – kind female", vendorId: "nova" },
      verse: { label: "Verse – calm narrator", vendorId: "verse" },
    },
  },
  Google: {
    label: "Google",
    desc: "Google TTS",
    defaultVoice: "jaB",
    voices: {
      jaB: { label: "JP-B – soft female", vendorId: "ja-JP-Neural2-B" },
      jaC: { label: "JP-C – soft male", vendorId: "ja-JP-Neural2-C" },
    },
  },
  Gemini: {
    label: "Gemini",
    desc: "2.5 Flash TTS",
    defaultVoice: "leda",
    voices: {
      leda: { label: "Leda – clear female", vendorId: "leda" },
      puck: { label: "Puck – clear male", vendorId: "puck" },
    },
  },
  ElevenLabs: {
    label: "ElevenLabs",
    desc: "Turbo v2.5",
    defaultVoice: "sameno",
    voices: {
      sameno: { label: "Sameno", vendorId: "hMK7c1GPJmptCzI4bQIu" },
    },
  },
  FishAudio: {
    label: "Fish Audio (demo)",
    desc: "Fish Audio TTS",
    defaultVoice: "sansan",
    voices: {
      sansan: { label: "サンサン", vendorId: "15454ccda92d4246a821a5d8f9728fb9" },
      pikachu: { label: "ピカチュウ", vendorId: "d940622bd99742c6b10ececd13c7ee1c" },
      doraemon: { label: "ドラえもん", vendorId: "7ad5d736bec7410090caf00dd91db21f" },
      conan: { label: "コナン", vendorId: "8481836597324f1697052575e2ca1a7e" },
      tanjiro: { label: "竈門炭治郎", vendorId: "00948a6e032249199e4a2699f0e0828e" },
      rengoku: { label: "煉獄杏寿郎", vendorId: "738068acdf0346d4ad15873cf582b9c9" },
      muzan: { label: "鬼舞辻無惨", vendorId: "18833cce92cc42e682f68073177f0e8f" },
      frieren: { label: "フリーレン", vendorId: "5a7a3dec0d9c415db57e9a7ce2ecee51" },
      fern: { label: "フェルン", vendorId: "1dac8f5fd50648388edfcb4ca6cfb378" },
      misato: { label: "葛城ミサト", vendorId: "5ec124a55410453a9c56aae75d3ba4c0" },
      makima: { label: "マキマ", vendorId: "028c4c7eb08c43358a3e30fef264ca0e" },
      reze: { label: "レゼ", vendorId: "6fdaebea7db042129f03ecb0a57ea7b6" },
      light: { label: "夜神月", vendorId: "4bc1d3d1fa60415f989b8e0b99f333e1" },
      naoya: { label: "禪院直哉", vendorId: "028e1ae4ba6d4c039ce29726a694500e" },
      marine: { label: "マリン船長", vendorId: "b24f3e45d0fc49ee942eb00741d70316" },
      hiroyuki: { label: "ひろゆき", vendorId: "f59b9bff8c37434aafed363ca72d14dc" },
      miwa: { label: "美輪明宏", vendorId: "d0407bac2cd14321bdfb492fa16506d7" },
      matsuko: { label: "マツコ・デラックス", vendorId: "e533e9f4f01d49dd8fb3e39dd3914464" },
    },
  },
} as const;

export type ModelKey = keyof typeof MODEL_MAP;
