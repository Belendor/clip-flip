const isBrowser = typeof window !== 'undefined';
const isLocal = isBrowser && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === ''
);

// Production server hosting the actual videos and thumbnails
const PROD_MEDIA_HOST = "http://56.228.95.201";

const prodDomain = isBrowser ? window.location.origin : "https://clip-flip.com";
const apiURL = isLocal ? "http://localhost:3000" : "/api";

const endIndex = 18367;

// When running locally, stream media directly from prod EC2 server
const videoPath    = isLocal ? `${PROD_MEDIA_HOST}/video/` : "/video/";
const videoPath1   = isLocal ? `${PROD_MEDIA_HOST}/video1/` : "/video1/";
const videoPathNew = isLocal ? `${PROD_MEDIA_HOST}/video1/new/` : "/video1/new/";
const thumbnailPath = isLocal ? `${PROD_MEDIA_HOST}/thumbnails/` : "/thumbnails/";
const videoThumbnailPath = isLocal ? `${PROD_MEDIA_HOST}/thumbnail/videos/` : "/thumbnail/videos/";

export const config = {
    isLocal:             isLocal,
    baseUrl:             prodDomain,
    videoSourcePath:     videoPath,
    videoSourcePath2:    videoPath1,
    videoSourcePathNew:  videoPathNew,
    thumbnailSourcePath: thumbnailPath,
    videoThumbnailPath:  videoThumbnailPath,
    defaultPercentChance: 25,
    defaultEndIndex:     endIndex,
    apiUrl:              apiURL,
    multiSection:        false,
    googleClientId:      "1005873499572-tfcfkhv3bhl9o8mbddvpnvsdi7ua5ele.apps.googleusercontent.com",
};
