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

// Remote clients (multi-view co-editing)
struct RemoteClient {
    int fd;
    int closePipe[2];
};
static std::mutex remoteClientsMutex;
static std::map<int, RemoteClient> remoteClients;

static void send2JS(const std::vector<char>& buffer)
{
    MAIN_THREAD_EM_ASM({
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

        if (typeof globalThis.onRemoteMessage === 'function') {
            globalThis.onRemoteMessage($0, data);
        }
    }, clientId, buffer.data(), buffer.size());
}

extern "C"
void handle_cool_message(const char *string_value)
{
    std::cout << "================ handle_cool_message(): '" << string_value << "'" << std::endl;

    if (string_value == std::string_view("HULLO"))
    {
        assert(coolwsd_server_socket_fd != -1);
        int rc = fakeSocketConnect(fakeClientFd, coolwsd_server_socket_fd);
        assert(rc != -1);

        fakeSocketPipe2(closeNotificationPipeForForwardingThread);

        // Start forwarding thread for local client: WASM → JS
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
                                   fakeSocketClose(closeNotificationPipeForForwardingThread[1]);
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
    else if (string_value == std::string_view("BYE"))
    {
        LOG_TRC_NOFILE("Document window terminating on JavaScript side. Closing our end of the socket.");
        fakeSocketClose(closeNotificationPipeForForwardingThread[0]);
    }
    else
    {
        fakeSocketWriteQueue(fakeClientFd, string_value, strlen(string_value));
    }
}

extern "C"
int create_remote_client(int clientId)
{

    int fd = fakeSocketSocket();
    assert(coolwsd_server_socket_fd != -1);
    int rc = fakeSocketConnect(fd, coolwsd_server_socket_fd);
    assert(rc != -1);

    RemoteClient client;
    client.fd = fd;
    fakeSocketPipe2(client.closePipe);

    {
        std::lock_guard<std::mutex> lock(remoteClientsMutex);
        remoteClients[clientId] = client;
    }

    // Start forwarding thread for this remote client: WASM → remote JS
    std::thread([clientId, fd, closePipeFd = client.closePipe[1]]
                {
                    Util::setThreadName("remote2js");
                    while (true)
                    {
                        struct pollfd pollfd[2];
                        pollfd[0].fd = fd;
                        pollfd[0].events = POLLIN;
                        pollfd[1].fd = closePipeFd;
                        pollfd[1].events = POLLIN;
                        if (fakeSocketPoll(pollfd, 2, -1) > 0)
                        {
                            if (pollfd[1].revents == POLLIN)
                            {
                                fakeSocketClose(closePipeFd);
                                fakeSocketClose(fd);
                                return;
                            }
                            if (pollfd[0].revents == POLLIN)
                            {
                                int n = fakeSocketAvailableDataLength(fd);
                                if (n == 0)
                                    return;
                                std::vector<char> buf(n);
                                n = fakeSocketRead(fd, buf.data(), n);
                                send2RemoteJS(clientId, buf);
                            }
                        }
                        else
                            break;
                    }
                }).detach();

    // Send the document URL to start loading for this client
    fakeSocketWriteQueue(fd, fileURL.c_str(), fileURL.size());

    std::cout << "================ create_remote_client(): clientId=" << clientId << " fd=" << fd << std::endl;
    return clientId;
}

extern "C"
void handle_remote_message(int clientId, const char *string_value)
{
    std::lock_guard<std::mutex> lock(remoteClientsMutex);
    auto it = remoteClients.find(clientId);
    if (it != remoteClients.end())
    {
        fakeSocketWriteQueue(it->second.fd, string_value, strlen(string_value));
    }
    else
    {
        std::cout << "================ handle_remote_message(): unknown clientId=" << clientId << std::endl;
    }
}

extern "C"
void close_remote_client(int clientId)
{
    std::cout << "================ close_remote_client(): clientId=" << clientId << std::endl;
    std::lock_guard<std::mutex> lock(remoteClientsMutex);
    auto it = remoteClients.find(clientId);
    if (it != remoteClients.end())
    {
        fakeSocketClose(it->second.closePipe[0]);
        remoteClients.erase(it);
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
            LOG_WRN("Failed to open " << tempFile << " for reading");
            return;
        }
        int e = std::fseek(f.get(), 0, SEEK_END);
        if (e != 0) {
            LOG_WRN("Failed to seek in " << tempFile);
            return;
        }
        n = std::ftell(f.get());
        if (n == -1) {
            LOG_WRN("Failed to get size of " << tempFile);
            return;
        }
        buf = std::make_unique<char[]>(n);
        std::rewind(f.get());
        std::size_t n2 = std::fread(buf.get(), 1, n, f.get());
        assert(n >= 0);
        if (n2 != static_cast<unsigned long>(n)) {
            LOG_WRN("Failed to get read " << tempFile);
            return;
        }
    }
    emscripten_fetch_attr_t attr;
    emscripten_fetch_attr_init(&attr);
    strcpy(attr.requestMethod, "POST");
    attr.attributes = EMSCRIPTEN_FETCH_SYNCHRONOUS;
    attr.requestData = buf.get();
    attr.requestDataSize = n;
    emscripten_fetch_t * fetch = emscripten_fetch(&attr, remoteUrl.c_str());
    emscripten_fetch_close(fetch);
    LOG_TRC("Saved " << tempFile << " back to <" << remoteUrl << ">: " << fetch->status);
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
                    &attr, remoteUrl.data());
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
                    std::exit(EXIT_FAILURE);
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
