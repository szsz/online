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

#include <common/Log.hpp>
#include <common/Util.hpp>

#include <fcntl.h>
#include <time.h>
#include <unistd.h>

#include <atomic>
#include <chrono>

namespace Util
{
    namespace rng
    {
        // /dev/urandom fd, mutable. On real Unix the first open() value
        // is good for the process lifetime. On WASM, a HEAPU8 snapshot
        // restore can leave this pointing at a stream slot that no longer
        // exists in the warm-visit emscripten FS — getBytes() detects
        // EBADF and calls invalidateURandom() to drop the cached value.
        static std::atomic<int> g_urandomFd{ -1 };

        static int openURandomFresh()
        {
            return open("/dev/urandom", O_RDONLY);
        }

        int getURandom()
        {
            int fd = g_urandomFd.load(std::memory_order_acquire);
            if (fd >= 0) return fd;
            int fresh = openURandomFresh();
            if (fresh < 0) return -1;
            int expected = -1;
            if (g_urandomFd.compare_exchange_strong(expected, fresh,
                                                     std::memory_order_acq_rel))
                return fresh;
            // Lost the race — another thread cached a value. Use that and
            // close the one we just opened.
            close(fresh);
            return g_urandomFd.load(std::memory_order_acquire);
        }

        // Drop the cached fd (called when read() returns EBADF — typical
        // after a WASM snapshot restore). Next getURandom() will open fresh.
        static void invalidateURandom()
        {
            int stale = g_urandomFd.exchange(-1, std::memory_order_acq_rel);
            // Don't close(stale): the fd no longer exists in the FS. Just
            // discard. close() would either be a no-op or report EBADF too.
            (void)stale;
        }

        // Best-effort fallback when /dev/urandom is unavailable. Mixes
        // wall-clock time, monotonic clock, and the address of a stack
        // local. NOT cryptographically secure — only used to avoid
        // crashing the entire process when entropy is unobtainable
        // (which on WASM only happens during the warm-restore window).
        // Crypto code uses OpenSSL's RAND_*, which has its own entropy
        // gathering and doesn't go through this path.
        static void fillFallback(char* p, size_t n)
        {
            const auto wall = std::chrono::system_clock::now().time_since_epoch().count();
            const auto mono = std::chrono::steady_clock::now().time_since_epoch().count();
            const auto stk  = reinterpret_cast<uintptr_t>(&p);
            uint64_t mix = static_cast<uint64_t>(wall)
                         ^ (static_cast<uint64_t>(mono) << 17)
                         ^ (static_cast<uint64_t>(stk) << 5);
            for (size_t i = 0; i < n; ++i)
            {
                // xorshift64 to spread the bits.
                mix ^= mix << 13; mix ^= mix >> 7; mix ^= mix << 17;
                p[i] = static_cast<char>(mix & 0xff);
            }
        }

        // Since we have a fd always open to /dev/urandom
        // 'read' is hopefully no less efficient than getrandom.
        std::vector<char> getBytes(const std::size_t length)
        {
            std::vector<char> v(length);
            char* p = v.data();
            size_t nbytes = length;
            // We're allowed to reopen at most once per call: WASM warm-restore
            // can leave the cached fd pointing at a freed emscripten stream,
            // and the first read returns EBADF. After one fresh open()+read()
            // it's stable for the rest of the process.
            bool reopened = false;

            while (nbytes)
            {
                int fd = getURandom();
                if (fd < 0)
                    break;
                ssize_t b = read(fd, p, nbytes);
                if (b <= 0)
                {
                    if (errno == EINTR)
                        continue;
                    if (errno == EBADF && !reopened)
                    {
                        // Cached fd is stale (typical post-snapshot-restore
                        // situation in WASM). Invalidate the cache so the
                        // next getURandom() opens fresh; loop back and try.
                        reopened = true;
                        invalidateURandom();
                        continue;
                    }
                    break;
                }

                assert(static_cast<size_t>(b) <= nbytes);

                nbytes -= b;
                p += b;
            }

            size_t offset = p - v.data();
            if (offset < length)
            {
                // Soft failure path. Log loudly but DO NOT abort — the
                // caller (e.g. mt19937_64 seeding) just needs *some* bytes;
                // crashing the entire wasm runtime over a missing
                // /dev/urandom is the wrong tradeoff for the warm-restore
                // window where this is recoverable.
                fprintf(stderr, "No adequate source of randomness, "
                        "failed to read %ld bytes: with error %s — "
                        "falling back to clock-based weak entropy\n",
                        (long int)length, strerror(errno));
                fillFallback(p, length - offset);
            }

            return v;
        }
    } // namespace rng

    long getProcessId()
    {
        return getpid();
    }

    std::tm *time_t_to_localtime(std::time_t t, std::tm& tm)
    {
        return localtime_r(&t, &tm);
    }

    std::tm *time_t_to_gmtime(std::time_t t, std::tm& tm)
    {
        return gmtime_r(&t, &tm);
    }
} // namespace Util

/* vim:set shiftwidth=4 softtabstop=4 expandtab: */
