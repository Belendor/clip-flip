const isBrowser = typeof window !== 'undefined';
const prodDomain = isBrowser ? window.location.origin : "https://clip-flip.com";
const apiURL = "/api";

const endIndex = 13642;

const videoPath    = "/video/";
const videoPath1   = "/video1/";
const videoPathNew = "/video1/new/";
const thumbnailPath = "/thumbnails/";

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
