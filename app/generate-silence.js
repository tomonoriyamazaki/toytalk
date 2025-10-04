const fs = require("fs");

function generateSilentWav(filename, durationMs = 200, sampleRate = 16000) {
  const numSamples = (durationMs / 1000) * sampleRate;
  const headerSize = 44;
  const dataSize = numSamples * 2; // 16bit = 2 bytes
  const totalSize = headerSize + dataSize;

  const buffer = Buffer.alloc(totalSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(totalSize - 8, 4);
  buffer.write("WAVE", 8);

  // fmt chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // PCM header size
  buffer.writeUInt16LE(1, 20); // format = PCM
  buffer.writeUInt16LE(1, 22); // channels = 1
  buffer.writeUInt32LE(sampleRate, 24); // sample rate
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample

  // data chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(filename, buffer);
  console.log("✅ Wrote", filename, "with", durationMs, "ms of silence");
}

generateSilentWav("silence.wav");
