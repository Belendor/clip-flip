import State from './State';
import Players from './Player';
import HTML from './HTML';
import User from "./User";
import VideoApi from './VideoApi';
import Profile from './Profile';
import ModelPage from './ModelPage';

document.addEventListener('DOMContentLoaded', async () => {
    const api = new VideoApi();
    const state = new State(api);
    const user = new User();
    const html = new HTML(state, api, user);

    const players = new Players(state, html, api, user);
    players.init();

    const modelPage = new ModelPage(
        api,
        state,
        async (modelName: string, videoId: number) => {
            await players.switchMode("model", modelName, videoId);
        },
        () => {
            // Pause players on model page open
            html.videoPlayers.forEach((p) => {
                if (!p.paused) p.pause();
            });
        },
        () => {
            // Callback on model page close
        }
    );
    players.setModelPage(modelPage);

    new Profile(
        user,
        api,
        state,
        () => {
            // Pause players on profile open
            html.videoPlayers.forEach((p) => {
                if (!p.paused) p.pause();
            });
        },
        () => {
            // Callback on profile close
        },
        async () => {
            // On watch liked clips
            await players.switchMode("liked");
        }
    );
});
