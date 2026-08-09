import {Config} from '@remotion/cli/config';

// H.264 / crf18 相当 / faststart は Remotion のデフォルトで付与される
Config.setVideoImageFormat('jpeg');
Config.setCodec('h264');
Config.setCrf(18);
