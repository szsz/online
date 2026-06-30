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

#if WASMAPP
#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/html5.h>
#include <emscripten/val.h>
#endif

extern int coolwsd_server_socket_fd;

extern "C" void handle_cool_message(const char *string_value);

// Multi-client support: allow remote clients to connect via relay
extern "C" int create_remote_client();
extern "C" void handle_remote_message(int clientId, const char *string_value);
extern "C" void close_remote_client(int clientId);

void saveToServer();

#include <string>
// Re-target the file-save path after a hot-doc switch. ChildSession's
// switchdocument writes the new doc to /tempdoc_switchN and fetches
// its bytes from a new URL; without rebinding wasmapp's tempFile +
// remoteUrl, kit's saveToServer keeps writing the prewarm-blank's
// tempfile and POSTing back to the prewarm-blank URL — every save
// after the first hot-switch is a no-op vs the user's actual doc.
void wasmAppRebindSaveTarget(const std::string& tempPath, const std::string& docRemoteUrl);

/* vim:set shiftwidth=4 softtabstop=4 expandtab cinoptions=b1,g0,N-s cinkeys+=0=break: */
