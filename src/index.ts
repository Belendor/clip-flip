import State from './State';
import Players from './Player';
import HTML from './HTML';
import User from "./User";
import VideoApi from './VideoApi';

document.addEventListener('DOMContentLoaded', async () => {
    const api = new VideoApi();
    const state = new State(api);
    const user = new User();
    const html = new HTML(state, api, user);

    const players = new Players(state, html, api, user);

    players.init();
});
