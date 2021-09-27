/*
Copyright 2021 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/


import * as express from "express";
import { JSDOM } from 'jsdom';
import { MatrixClient } from "matrix-bot-sdk";

import config from "../config";


/**
 * A common prefix for all web-exposed APIs.
 */
const API_PREFIX: string = "/api/1";

const AUTHENTICATION: RegExp = new RegExp("Bearer (.*)");

export class WebAPIs {
    private webServer: express.Express = express();

    constructor(private client: MatrixClient) {
    }

    /**
     * Start accepting requests to the Web API.
     */
    public async start() {
        this.webServer.listen(config.web.port, config.web.address);

        // Configure /report API.
        if (config.web.enabled && config.web.abuseReporting.enabled) {
            this.webServer.post(`${API_PREFIX}/report/:room_id/:event_id`, (request, response) =>
                this.handleReport({ request, response, roomId: request.params.room_id, eventId: request.params.event_id })
            )
        }
    }

    /**
     * Handle a call to the /report API.
     * 
     * In case of success, respond an empty JSON body.
     *
     * @param roomId The room in which the reported event took place. Already extracted from the URL.
     * @param eventId The event. Already extracted from the URL.
     * @param request The request. Its body SHOULD hold an object `{reason?: string}`
     * @param response The response. Used to propagate HTTP success/error.
     */
    async handleReport({ roomId, eventId, request, response }: { roomId: string, eventId: string, request: express.Request, response: express.Response }) {
        // To display any kind of useful information, we need
        //
        // 1. The reporter id;
        // 2. The accused id, to be able to warn/kick/ban them if necessary;
        // 3. The content of the event **if the room is unencrypted**.

        try {
            // -- Create a client on behalf of the reporter.
            // We'll use it to confirm the authenticity of the report.
            let accessToken;

            // Authentication mechanism 1: Request header.
            let authentication = request.get('authentication');

            if (authentication) {
                [, accessToken] = AUTHENTICATION.exec(authentication)!;
            } else {
                    // Authentication mechanism 2: Access token as query parameter.
                accessToken = request.query["access_token"];
            }

            // Create a client dedicated to this report.
            //
            // VERY IMPORTANT NOTES
            //
            // We're impersonating the user to get the context of the report.
            //
            // For privacy's sake, we MUST ensure that:
            //
            // - we DO NOT sync with this client;
            // - we DO NOT associate a crypto store (e.g. Pantalaimon),
            //    as this would let us read encrypted messages.
            let reporterClient = new MatrixClient(config.rawHomeserverUrl, accessToken);
            reporterClient.start = () => {
                throw new Error("We MUST NEVER call start on the reporter client");
            };

            let whoami: any = await reporterClient.doRequest("GET", "/_matrix/client/r0/account/whoami");
            let reporterId = whoami["user_id"];

            /*
             Past this point, the following invariants hold:

             - The report was sent by a Matrix user.
             - The identity of the Matrix user who sent the report is stored in `reporterId`.
             */

            // Now, let's gather more info on the event.
            // IMPORTANT: The following call will return the event without decyphering it, so we're
            // not obtaining anything that we couldn't also obtain through a homeserver's Admin API.
            let event: any = await reporterClient.doRequest("GET", `/_matrix/client/r0/rooms/${roomId}/event/${eventId})`);
            let accusedId: string = event["sender"];


            /*
            Past this point, the following invariants hold:
            
            - The reporter is a member of `roomId`.
            - Event `eventId` did take place in room `roomId`.
            - The reporter could witness event `eventId` in room `roomId`.
            - Event `eventId` was reported by user `accusedId`.
            */

            let { displayname: reporterDisplayName }: { displayname: string } = await reporterClient.doRequest("GET", `/_matrix/client/r0/profile/${reporterId}/displayname`);
            let { displayname: accusedDisplayName }: { displayname: string } = await reporterClient.doRequest("GET", `/_matrix/client/r0/profile/${accusedId}/displayname`);
            let roomAliasOrID = await reporterClient.getPublishedAlias(roomId) || roomId;
            let eventShortcut = `https://matrix.to/#/${roomId}/${eventId}`;
            let roomShortcut = `https://matrix.to/#/${roomAliasOrID}`;
            let eventContent;
            if (event["type"] == "m.room.encrypted") {
                eventContent = "<encrypted content>";
            } else {
                eventContent = JSON.stringify(event["content"], null, 2);
            }

            // We now have all the information we need to produce an abuse report.

            // We need to send the report as html to be able to use spoiler markings.
            // We build this as dom to be absolutely certain that we're not introducing
            // any kind of injection within the report.
            const document = new JSDOM("<body>User <code id='reporter-display-name'></code> (<code id='reporter-id'></code>) reported <a id='event-shortcut'>event <span id='event-id'></span></a> by user <b><span id='accused-display-name'></span>(<span id='accused-id'></span>)</b> in <a id='room-shortcut'>room <span id='room-alias-or-id'></span></a>.<div>Event content <div id='event-container'><code id='event-content'></code><div></body>").window.document;
            // ...insert text content
            for (let [key, value] of [
                ['reporter-display-name', reporterDisplayName],
                ['reporter-id', reporterId],
                ['accused-display-name', accusedDisplayName],
                ['accused-id', accusedId],
                ['event-id', eventId],
                ['room-alias-or-id', roomAliasOrID],
                ['event-content', eventContent]
            ]) {
                document.getElementById(key)!.textContent = value;
            }
            // ...insert attributes
            for (let [key, value] of [
                ['event-shortcut', eventShortcut],
                ['room-shortcut', roomShortcut],
            ]) {
                (document.getElementById(key)! as HTMLAnchorElement).href = value;
            }
            // ...set presentation
            if (event["type"] != "m.room.encrypted") {
                // If there's some event content, mark it as a spoiler.
                document.getElementById('event-container')!.
                    setAttribute("data-mx-spoiler", "");
            }

            // Possible evolutions: in future versions, we could add the ability to one-click discard, kick, ban.

            // Send the report and we're done!
            // We MUST send this report with the regular Mjölnir client.
            await this.client.sendHtmlNotice(config.managementRoom, document.body.outerHTML);

            // Match the spec behavior of `/report`: return 200 and an empty JSON.
            response.status(200).json({});
        } catch (ex) {
            console.warn("Error responding to an abuse report", roomId, eventId, ex);
        }
    }
}
