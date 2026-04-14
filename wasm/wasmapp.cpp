/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4; fill-column: 100 -*- */
/*
 * Copyright the Collabora Online contributors.
 *
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

#include <config.h>

#include "wasmapp.hpp"

#include <common/Log.hpp>
#include <common/Util.hpp>
#include <net/FakeSocket.hpp>
#include <wsd/COOLWSD.hpp>

#include <emscripten/fetch.h>

#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <memory>
#include <mutex>

int coolwsd_server_socket_fd = -1;

static char const * tempFile; // null when operating on a local file in the Emscripten file system
static std::string remoteUrl;
static std::string fileURL;
static int fakeClientFd;
static int closeNotificationPipeForForwardingThread[2] = {-1, -1};

// Multi-client support for remote collaborative editing via relay
struct RemoteClient {
    int fakeClientFd;
    int closeNotificationPipe[2];
};
static std::map<int, RemoteClient> remoteClients;
static std::mutex remoteClientsMutex;
static int nextRemoteClientId = 1;
// Queue of ready client IDs (thread-safe)
static std::mutex g_readyMutex;
static std::vector<int> g_readyClientIds;

static void send2JS(const std::vector<char>& buffer)
{
    MAIN_THREAD_EM_ASM({
        // Check if the message is binary. We say that any message that isn't just a single line is
        // "binary" even if that strictly speaking isn't the case; for instance the commandvalues:
        // message has a long bunch of non-binary JSON on multiple lines. But _onMessage() in
        // Socket.js handles it fine even if such a message, too, comes in as an ArrayBuffer. (Look
        // for the "textMsg = String.fromCharCode.apply(null, imgBytes);".)

        let newline = false;
        for (let i = 0; i != $1; ++i) {
            if (HEAPU8[$0 + i] === 0x0A) {
                newline = true;
                break;
            }
        }
        let data = HEAPU8.slice($0, $0 + $1);
        if (!newline) {
            data = new TextDecoder().decode(data);
        }

        globalThis.TheFakeWebSocket.onmessage({data});
    }, buffer.data(), buffer.size());
}

static void send2RemoteJS(int clientId, const std::vector<char>& buffer)
{
    MAIN_THREAD_EM_ASM({
        let newline = false;
        for (let i = 0; i != $2; ++i) {
            if (HEAPU8[$1 + i] === 0x0A) {
                newline = true;
                break;
            }
        }
        let data = HEAPU8.slice($1, $1 + $2);
        if (!newline) {
            data = new TextDecoder().decode(data);
        }
        if (globalThis.onRemoteClientMessage) {
            globalThis.onRemoteClientMessage($0, data);
        }
    }, clientId, buffer.data(), buffer.size());
}

extern "C"
EMSCRIPTEN_KEEPALIVE
int create_remote_client()
{
    assert(coolwsd_server_socket_fd != -1);

    int clientId;
    {
        std::lock_guard<std::mutex> lock(remoteClientsMutex);
        clientId = nextRemoteClientId++;
    }

    // Must run connect in a thread — fakeSocketConnect blocks until COOLWSD
    // accepts, which requires the main thread to yield. Doing it on the main
    // thread deadlocks.
    // Use an atomic flag for JS to poll readiness.
    std::thread([clientId]
                {
                    Util::setThreadName("relay_" + std::to_string(clientId));

                    int clientFd = fakeSocketSocket();
                    int rc = fakeSocketConnect(clientFd, coolwsd_server_socket_fd);
                    if (rc == -1)
                    {
                        std::cerr << "Remote client " << clientId << " connect failed" << std::endl;
                        return;
                    }

                    RemoteClient client;
                    client.fakeClientFd = clientFd;
                    fakeSocketPipe2(client.closeNotificationPipe);

                    {
                        std::lock_guard<std::mutex> lock(remoteClientsMutex);
                        remoteClients[clientId] = client;
                    }

                    std::cout << "Remote client " << clientId << " connected fd=" << clientFd << std::endl;

                    // Send the document URL (first message, like HULLO does for local client)
                    fakeSocketWriteQueue(clientFd, fileURL.c_str(), fileURL.size());

                    // Send init sequence with delays for Kit to process
                    std::this_thread::sleep_for(std::chrono::seconds(2));

                    std::string coolclient = "coolclient 0.1 0 0";
                    fakeSocketWriteQueue(clientFd, coolclient.c_str(), coolclient.size());
                    std::cout << "Remote client " << clientId << " sent coolclient" << std::endl;

                    std::this_thread::sleep_for(std::chrono::seconds(2));

                    std::string docName;
                    if (remoteUrl.size() > 6)
                        docName = remoteUrl.substr(6);
                    else
                        docName = "document";
                    std::string loadCmd = "load url=" + docName +
                        " lang=en-US deviceFormFactor=desktop timezone=Etc/UTC"
                        " darkTheme=false darkBackground=false";
                    fakeSocketWriteQueue(clientFd, loadCmd.c_str(), loadCmd.size());
                    std::cout << "Remote client " << clientId << " sent load: " << loadCmd.substr(0, 50) << std::endl;

                    // Wait for Kit to load the view — poll for commandresult
                    // instead of blind sleep. Supports large documents.
                    {
                        auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(120);
                        bool loaded = false;
                        while (std::chrono::steady_clock::now() < deadline)
                        {
                            struct pollfd pfd;
                            pfd.fd = clientFd;
                            pfd.events = POLLIN;
                            int r = fakeSocketPoll(&pfd, 1, 1000); // 1s poll
                            if (r > 0 && (pfd.revents & POLLIN))
                            {
                                int n = fakeSocketAvailableDataLength(clientFd);
                                if (n <= 0) break;
                                std::vector<char> buf(n);
                                n = fakeSocketRead(clientFd, buf.data(), n);
                                std::string msg(buf.data(), n);
                                // Forward to JS (for tile rendering etc.)
                                send2RemoteJS(clientId, buf);

                                if (msg.find("commandresult:") != std::string::npos &&
                                    msg.find("\"load\"") != std::string::npos &&
                                    msg.find("\"success\"") != std::string::npos)
                                {
                                    std::cout << "Remote client " << clientId
                                              << " loaded (commandresult)" << std::endl;
                                    loaded = true;
                                    break;
                                }
                            }
                        }
                        if (!loaded)
                            std::cout << "Remote client " << clientId
                                      << " load timeout (120s) — signaling ready anyway" << std::endl;
                    }

                    // Send viewport setup so the Kit can map mouse coordinates.
                    // Without these, mouse events hit the wrong document position
                    // and cursor-dependent UNO commands (InsertRows etc.) fail.
                    {
                        std::string zoom = "clientzoom tilepixelwidth=256 tilepixelheight=256 tiletwipwidth=6636 tiletwipheight=6636";
                        fakeSocketWriteQueue(clientFd, zoom.c_str(), zoom.size());
                        std::string visarea = "clientvisiblearea x=0 y=0 width=19195 height=11535 splitx=0 splity=0";
                        fakeSocketWriteQueue(clientFd, visarea.c_str(), visarea.size());
                        std::cout << "Remote client " << clientId << " sent viewport setup" << std::endl;
                    }

                    // Signal JS that this client is ready
                    {
                        std::lock_guard<std::mutex> lock(g_readyMutex);
                        g_readyClientIds.push_back(clientId);
                    }
                    std::cout << "Remote client " << clientId << " signaled ready" << std::endl;

                    // Forwarding loop
                    int closePipe1 = client.closeNotificationPipe[1];
                    while (true)
                    {
                        struct pollfd pollfd[2];
                        pollfd[0].fd = clientFd;
                        pollfd[0].events = POLLIN;
                        pollfd[1].fd = closePipe1;
                        pollfd[1].events = POLLIN;
                        if (fakeSocketPoll(pollfd, 2, -1) > 0)
                        {
                            if (pollfd[1].revents == POLLIN)
                            {
                                fakeSocketClose(closePipe1);
                                fakeSocketClose(clientFd);
                                return;
                            }
                            if (pollfd[0].revents == POLLIN)
                            {
                                int n = fakeSocketAvailableDataLength(clientFd);
                                if (n == 0)
                                    return;
                                std::vector<char> buf(n);
                                n = fakeSocketRead(clientFd, buf.data(), n);
                                send2RemoteJS(clientId, buf);
                            }
                        }
                        else
                            break;
                    }
                }).detach();

    return clientId;
}

extern "C"
EMSCRIPTEN_KEEPALIVE
int poll_remote_client_ready()
{
    std::lock_guard<std::mutex> lock(g_readyMutex);
    if (g_readyClientIds.empty())
        return 0;
    int id = g_readyClientIds.front();
    g_readyClientIds.erase(g_readyClientIds.begin());
    return id;
}

extern "C"
EMSCRIPTEN_KEEPALIVE
void handle_remote_message(int clientId, const char *string_value)
{
    std::lock_guard<std::mutex> lock(remoteClientsMutex);
    auto it = remoteClients.find(clientId);
    if (it == remoteClients.end())
    {
        std::cerr << "handle_remote_message: unknown client " << clientId << std::endl;
        return;
    }
    std::cout << "handle_remote_message(" << clientId << "): " << std::string(string_value).substr(0, 60) << std::endl;
    fakeSocketWriteQueue(it->second.fakeClientFd, string_value, strlen(string_value));
}

extern "C"
EMSCRIPTEN_KEEPALIVE
void close_remote_client(int clientId)
{
    std::lock_guard<std::mutex> lock(remoteClientsMutex);
    auto it = remoteClients.find(clientId);
    if (it == remoteClients.end())
        return;
    fakeSocketClose(it->second.closeNotificationPipe[0]);
    remoteClients.erase(it);
    std::cout << "Closed remote client " << clientId << std::endl;
}

extern "C"
void handle_cool_message(const char *string_value)
{
    std::cout << "================ handle_cool_message(): '" << string_value << "'" << std::endl;

    if (strcmp(string_value, "HULLO") == 0)
    {
        // Now we know that the JS has started completely

        // Contact the permanently (during app lifetime) listening COOLWSD server
        // "public" socket
        assert(coolwsd_server_socket_fd != -1);
        int rc = fakeSocketConnect(fakeClientFd, coolwsd_server_socket_fd);
        assert(rc != -1);

        // Create a socket pair to notify the below thread when the document has been closed
        fakeSocketPipe2(closeNotificationPipeForForwardingThread);

        // Start another thread to read responses and forward them to the JavaScript
        std::thread([]
                    {
                        Util::setThreadName("app2js");
                        while (true)
                        {
                           struct pollfd pollfd[2];
                           pollfd[0].fd = fakeClientFd;
                           pollfd[0].events = POLLIN;
                           pollfd[1].fd = closeNotificationPipeForForwardingThread[1];
                           pollfd[1].events = POLLIN;
                           if (fakeSocketPoll(pollfd, 2, -1) > 0)
                           {
                               if (pollfd[1].revents == POLLIN)
                               {
                                   // The code below handling the "BYE" fake Websocket
                                   // message has closed the other end of the
                                   // closeNotificationPipeForForwardingThread. Let's close
                                   // the other end too just for cleanliness, even if a
                                   // FakeSocket as such is not a system resource so nothing
                                   // is saved by closing it.
                                   fakeSocketClose(closeNotificationPipeForForwardingThread[1]);

                                   // Close our end of the fake socket connection to the
                                   // ClientSession thread, so that it terminates
                                   fakeSocketClose(fakeClientFd);

                                   return;
                               }
                               if (pollfd[0].revents == POLLIN)
                               {
                                   int n = fakeSocketAvailableDataLength(fakeClientFd);
                                   if (n == 0)
                                       return;
                                   std::vector<char> buf(n);
                                   n = fakeSocketRead(fakeClientFd, buf.data(), n);
                                   send2JS(buf);
                               }
                           }
                           else
                               break;
                       }
                       assert(false);
                    }).detach();

        LOG_TRC_NOFILE("Actually sending to Online:" << fileURL);
        std::cout << "Loading file [" << fileURL << "]" << std::endl;

        fakeSocketWriteQueue(fakeClientFd, fileURL.c_str(), fileURL.size());
    }
    else if (strcmp(string_value, "BYE") == 0)
    {
        LOG_TRC_NOFILE("Document window terminating on JavaScript side. Closing our end of the socket.");

        // Close one end of the socket pair, that will wake up the forwarding thread above
        fakeSocketClose(closeNotificationPipeForForwardingThread[0]);
    }
    else
    {
        fakeSocketWriteQueue(fakeClientFd, string_value, strlen(string_value));
    }
}

namespace {
struct FileClose {
    void operator ()(FILE * f) { std::fclose(f); }
};
}

void saveToServer() {
    if (tempFile == nullptr) {
        return;
    }
    long n;
    std::unique_ptr<char[]> buf;
    {
        auto const f = std::unique_ptr<FILE, FileClose>(std::fopen(tempFile, "r"));
        if (f.get() == nullptr) {
            LOG_WRN("Failed to open " << tempFile << " for reading"); //TODO
            return;
        }
        int e = std::fseek(f.get(), 0, SEEK_END);
        if (e != 0) {
            LOG_WRN("Failed to seek in " << tempFile); //TODO
            return;
        }
        n = std::ftell(f.get());
        if (n == -1) {
            LOG_WRN("Failed to get size of " << tempFile); //TODO
            return;
        }
        buf = std::make_unique<char[]>(n);
        std::rewind(f.get());
        std::size_t n2 = std::fread(buf.get(), 1, n, f.get());
        assert(n >= 0);
        if (n2 != static_cast<unsigned long>(n)) {
            LOG_WRN("Failed to get read " << tempFile); //TODO
            return;
        }
    }
    emscripten_fetch_attr_t attr;
    emscripten_fetch_attr_init(&attr);
    strcpy(attr.requestMethod, "POST");
    attr.attributes = EMSCRIPTEN_FETCH_SYNCHRONOUS; //TODO: make this asynchronous
    attr.requestData = buf.get();
    attr.requestDataSize = n;
    emscripten_fetch_t * fetch = emscripten_fetch(&attr, remoteUrl.c_str());
    emscripten_fetch_close(fetch);
    LOG_TRC("Saved " << tempFile << " back to <" << remoteUrl << ">: " << fetch->status);
    //TODO: handle fetch->status != 200
}

int main(int argc, char* argv_main[])
{
    std::cout << "================ Here is main()" << std::endl;

    assert(argc == 3);

    Log::initialize("WASM", "error");
    Util::setThreadName("main");

    fakeSocketSetLoggingCallback([](const std::string& line)
                                 {
                                     LOG_TRC_NOFILE(line);
                                 });

    char *argv[2];
    argv[0] = strdup("wasm");
    argv[1] = nullptr;

    fakeClientFd = fakeSocketSocket();

    // We run COOOLWSD::run() in a thread of its own so that main() can return.
    std::thread(
        [&]
        {
            Util::setThreadName("COOLWSD::run");

            const std::string docKind = std::string(argv_main[1]);
            const std::string docDesc = std::string(argv_main[2]);

            if (docKind == "server")
            {
                remoteUrl = "/wasm/" + docDesc;

                printf("Fetching from url %s\n", remoteUrl.c_str());

                emscripten_fetch_attr_t attr;
                emscripten_fetch_attr_init(&attr);
                strcpy(attr.requestMethod, "GET");
                attr.attributes = EMSCRIPTEN_FETCH_LOAD_TO_MEMORY | EMSCRIPTEN_FETCH_SYNCHRONOUS;
                emscripten_fetch_t* fetch = emscripten_fetch(
                    &attr, remoteUrl.data()); // Blocks here until the operation is complete.
                if (fetch->status == 200)
                {
                    printf("Finished downloading %llu bytes from URL %s.\n", fetch->numBytes,
                           fetch->url);
                    tempFile = "/tempdoc";
                    FILE* f = fopen(tempFile, "w");
                    const int wrote = fwrite(fetch->data, 1, fetch->numBytes, f);
                    fclose(f);
                    printf("Wrote %d bytes into %s\n", wrote, tempFile);
                    fileURL = std::string("file://") + tempFile;
                }
                else
                {
                    printf("Downloading %s failed, HTTP failure status code: %d.\n", fetch->url,
                           fetch->status);
                    std::exit(EXIT_FAILURE); //TODO: error handling
                }
                emscripten_fetch_close(fetch);
            }
            else if (docKind == "local")
            {
                fileURL = docDesc;
            }
            else
            {
                assert(false);
            }

            COOLWSD *coolwsd = new COOLWSD();
            coolwsd->run(1, argv);
            delete coolwsd;
        })
        .detach();

    std::cout << "================ main() is returning" << std::endl;
    return 0;
}

/* vim:set shiftwidth=4 softtabstop=4 expandtab cinoptions=b1,g0,N-s cinkeys+=0=break: */
