const isBrowser = typeof window !== 'undefined';
const prodDomain = "https://clip-flip.com";
const apiURL = "https://clip-flip.com/api";

const endIndex = 13642;

const videoPath    = `${prodDomain}/video/`;
const videoPath1   = `${prodDomain}/video1/`;
const videoPathNew = `${prodDomain}/video1/new/`;
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
