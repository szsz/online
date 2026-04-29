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

#pragma once

/*
 * HTTP server configuration and setup.
 * Classes: COOLWSDServer
 */

#include <ServerSocket.hpp>

class Admin;

/// The main server thread.
///
/// Waits for the connections from the cools, and creates the
/// websockethandlers accordingly.
class COOLWSDServer
{
    COOLWSDServer(COOLWSDServer&& other) = delete;
    const COOLWSDServer& operator=(COOLWSDServer&& other) = delete;
public:
    COOLWSDServer();
    ~COOLWSDServer();
    std::shared_ptr<ServerSocket> findClientPort();
    void startPrisoners();
    static void stopPrisoners();
    void start(std::shared_ptr<ServerSocket>&& serverSocket);
    void stop();
    void dumpState(std::ostream& os) const;

#ifdef __EMSCRIPTEN__
    /// Plan C — called from the COOLWSD main poll loop when wasmshim::isQuiesce()
    /// returns true. Joins _acceptPoll on the SAME thread (the COOLWSD thread is
    /// itself parking), so we cannot join from any other context. Caller is
    /// responsible for joining PrisonerPoll / WebServerPoll separately and for
    /// blocking on the resume condvar after this returns.
    void joinAcceptPoll();
    void restartAcceptPoll();
#endif

private:
    class AcceptPoll : public TerminatingPoll {
    public:
        AcceptPoll(const std::string &threadName) :
            TerminatingPoll(threadName) {}

        void wakeupHook() override;
    };
    /// This thread & poll accepts incoming connections.
    AcceptPoll _acceptPoll;

#ifdef __EMSCRIPTEN__
    /// Plan-C: SocketPoll::joinThread → removeSockets() destroys every
    /// shared_ptr in the poll, including the listener. On restart the
    /// poll has nothing to accept on. Keep a separate ref here so the
    /// listener fd survives the join, and re-insert in restartAcceptPoll.
    std::shared_ptr<ServerSocket> _serverSocket;
#endif

#if !MOBILEAPP
    Admin& _admin;
#endif

    /// Create the internal only, local socket for forkit / kits prisoners to talk to.
    std::shared_ptr<ServerSocket> findPrisonerServerPort();

    /// Create the externally listening public socket
    std::shared_ptr<ServerSocket> findServerPort();

public:
    /// This thread polls basic web serving, and handling of
    /// websockets before upgrade: when upgraded they go to the
    /// relevant DocumentBroker poll instead.
    static std::shared_ptr<TerminatingPoll> WebServerPoll;
    /// The Web Server instance with the accept socket poll thread.
    static std::unique_ptr<COOLWSDServer> Instance;
};

/* vim:set shiftwidth=4 softtabstop=4 expandtab: */
