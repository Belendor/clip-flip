const isBrowser = typeof window !== 'undefined';
const isProduction = isBrowser && (
    window.location.hostname === 'clip-flip.com' ||
    window.location.hostname === 'www.clip-flip.com'
);

console.log(`Running in ${isProduction ? 'production' : 'development'} mode`);

// In production: use prod API. In dev: use local backend.
const local = !isProduction;

const prodDomain = "https://clip-flip.com";
const apiURL = local ? `http://127.0.0.1:3000` : `${prodDomain}/api`;

const endIndex = 13642;

const videoPath    = `${prodDomain}/video/`;
const videoPath1   = `${prodDomain}/video1/`;
const videoPathNew = local ? "./video1/new/" : `${prodDomain}/video1/new/`;
const thumbnailPath = `${prodDomain}/thumbnails/`;

export const config = {
    baseUrl:             prodDomain,
    videoSourcePath:     videoPath,
    videoSourcePath2:    videoPath1,
    videoSourcePathNew:  videoPathNew,
    thumbnailSourcePath: thumbnailPath,
    defaultPercentChance: 25,
    defaultEndIndex:     endIndex,
    apiUrl:              apiURL,
    multiSection:        false,
    googleClientId:      "1005873499572-tfcfkhv3bhl9o8mbddvpnvsdi7ua5ele.apps.googleusercontent.com",
};
