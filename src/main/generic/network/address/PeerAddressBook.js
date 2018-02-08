// TODO Limit the number of addresses we store.
class PeerAddressBook extends Observable {
    /**
     * @constructor
     * @param {NetworkConfig} networkConfig
     */
    constructor(networkConfig) {
        super();

         /**
         * @type {NetworkConfig}
         * @private
         */
        this._networkConfig = networkConfig;

        /**
         * List services for peer addresses
         * @type {PeerAddressList}
         * @private
         */
        this._addressList = new PeerAddressList();

        /**
         * Pick & score peer addresses
         * @type {PeerAddressScoring}
         * @private
         */
        this._examiner = new PeerAddressScoring(this._addressList, this._networkConfig);

        // Init seed peers.
        this.add(/*channel*/ null, PeerAddressBook.SEED_PEERS);

        // Setup housekeeping interval.
        setInterval(() => this._housekeeping(), PeerAddressBook.HOUSEKEEPING_INTERVAL);
    }

    /** @type {PeerAddressList} */
    get addressList() {
        return this._addressList;
    }

    /** @type {PeerAddressScoring} */
    get examiner() {
        return this._examiner;
    }


    /**
     * @todo improve this by returning the best addresses first.
     * @param {number} protocolMask
     * @param {number} serviceMask
     * @param {number} maxAddresses
     * @returns {Array.<PeerAddress>}
     */
    query(protocolMask, serviceMask, maxAddresses = 1000) {
        // XXX inefficient linear scan
        const now = Date.now();
        const addresses = [];
        for (const peerAddressState of this._addressList.values()) {
            // Never return banned or failed addresses.
            if (peerAddressState.state === PeerAddressState.BANNED
                    || peerAddressState.state === PeerAddressState.FAILED) {
                continue;
            }

            // Never return seed peers.
            const address = peerAddressState.peerAddress;
            if (address.isSeed()) {
                continue;
            }

            // Only return addresses matching the protocol mask.
            if ((address.protocol & protocolMask) === 0) {
                continue;
            }

            // Only return addresses matching the service mask.
            if ((address.services & serviceMask) === 0) {
                continue;
            }

            // Update timestamp for connected peers.
            if (peerAddressState.state === PeerAddressState.CONNECTED) {
                // Also update timestamp for RTC connections
                if (peerAddressState.bestRoute) {
                    peerAddressState.bestRoute.timestamp = now;
                }
            }

            // Never return addresses that are too old.
            if (address.exceedsAge()) {
                continue;
            }

            // Return this address.
            addresses.push(address);

            // Stop if we have collected maxAddresses.
            if (addresses.length >= maxAddresses) {
                break;
            }
        }        return addresses;
    }

    /**
     * @param {PeerChannel} channel
     * @param {PeerAddress|Array.<PeerAddress>} arg
     */
    add(channel, arg) {
        const peerAddresses = Array.isArray(arg) ? arg : [arg];
        const newAddresses = [];

        for (const addr of peerAddresses) {
            if (this._add(channel, addr)) {
                newAddresses.push(addr);
            }
        }

        // Tell listeners that we learned new addresses.
        if (newAddresses.length) {
            this.fire('added', newAddresses, this);
        }
    }

    /**
     * @param {PeerChannel} channel
     * @param {PeerAddress|RtcPeerAddress} peerAddress
     * @returns {boolean}
     * @private
     */
    _add(channel, peerAddress) {
        // Ignore our own address.
        if (this._networkConfig.peerAddress.equals(peerAddress)) {
            return false;
        }

        // Ignore address if it is too old.
        // Special case: allow seed addresses (timestamp == 0) via null channel.
        if (channel && peerAddress.exceedsAge()) {
            Log.d(PeerAddressBook, `Ignoring address ${peerAddress} - too old (${new Date(peerAddress.timestamp)})`);
            return false;
        }

        // Ignore address if its timestamp is too far in the future.
        if (peerAddress.timestamp > Date.now() + PeerAddressBook.MAX_TIMESTAMP_DRIFT) {
            Log.d(PeerAddressBook, `Ignoring addresses ${peerAddress} - timestamp in the future`);
            return false;
        }

        // Increment distance values of RTC addresses.
        if (peerAddress.protocol === Protocol.RTC) {
            peerAddress.distance++;

            // Ignore address if it exceeds max distance.
            if (peerAddress.distance > PeerAddressBook.MAX_DISTANCE) {
                Log.d(PeerAddressBook, `Ignoring address ${peerAddress} - max distance exceeded`);
                // Drop any route to this peer over the current channel. This may prevent loops.
                const peerAddressState = this._addressList.get(peerAddress);
                if (peerAddressState) {
                    peerAddressState.deleteRoute(channel);
                }
                return false;
            }
        }

        // Check if we already know this address.
        let peerAddressState = this._addressList.get(peerAddress);
        if (peerAddressState) {
            const knownAddress = peerAddressState.peerAddress;

            // Ignore address if it is banned.
            if (peerAddressState.state === PeerAddressState.BANNED) {
                return false;
            }

            // Never update seed peers.
            if (knownAddress.isSeed()) {
                return false;
            }

            // Never erase NetAddresses.
            if (knownAddress.netAddress && !peerAddress.netAddress) {
                peerAddress.netAddress = knownAddress.netAddress;
            }

            // Ignore address if it is a websocket address and we already know this address with a more recent timestamp.
            if (peerAddress.protocol === Protocol.WS && knownAddress.timestamp >= peerAddress.timestamp) {
                return false;
            }
        } else {
            // Add new peerAddressState.
            peerAddressState = new PeerAddressState(peerAddress);
            this._addressList.add(peerAddressState);
            if (peerAddress.protocol === Protocol.RTC) {
                // Index by peerId.
                this._addressList.putPeerId(peerAddress.peerId, peerAddressState);
            }
        }

        // Add route.
        if (peerAddress.protocol === Protocol.RTC) {
            peerAddressState.addRoute(channel, peerAddress.distance, peerAddress.timestamp);
        }

        // Update the address.
        peerAddressState.peerAddress = peerAddress;

        return true;
    }

    /**
     * Called when a connection to this peerAddress is being established.
     * @param {PeerAddress} peerAddress
     * @returns {void}
     */
    connecting(peerAddress) {
        this._transition(peerAddress, this.connecting);
    }

    /**
     * Called when a connection to this peerAddress has been established.
     * The connection might have been initiated by the other peer, so address
     * may not be known previously.
     * If it is already known, it has been updated by a previous version message.
     * @param {PeerChannel} channel
     * @param {PeerAddress|RtcPeerAddress} peerAddress
     * @returns {void}
     */
    connected(channel, peerAddress) {
        this._transition(peerAddress, this.connected, {channel});
    }

    /**
     * Called when a connection to this peerAddress is closed.
     * @param {PeerChannel} channel
     * @param {PeerAddress} peerAddress
     * @param {boolean} closedByRemote
     * @returns {void}
     */
    disconnected(channel, peerAddress, closedByRemote) {
        this._transition(peerAddress, this.disconnected, {channel, closedByRemote});
    }

    /**
     * Called when a network connection to this peerAddress has failed.
     * @param {PeerAddress} peerAddress
     * @returns {void}
     */
    failure(peerAddress) {
        this._transition(peerAddress, this.failure);
    }

    /**
     * Called when a message has been returned as unroutable.
     * @param {PeerChannel} channel
     * @param {PeerAddress} peerAddress
     * @returns {void}
     */
    unroutable(channel, peerAddress) {
        this._transition(peerAddress, this.unroutable, {channel});
    }

    /**
     * @param {PeerAddress} peerAddress
     * @param {number} [duration] in milliseconds
     * @returns {void}
     */
    ban(peerAddress, duration = PeerAddressBook.DEFAULT_BAN_TIME) {
        this._transition(peerAddress, this.ban, {duration});
    }

    /**
     * @param {PeerAddress} peerAddress
     * @returns {boolean}
     */
    isConnected(peerAddress) {
        const peerAddressState = this._addressList.get(peerAddress);
        return peerAddressState && peerAddressState.state === PeerAddressState.CONNECTED;
    }

    /**
     * @param {PeerAddress} peerAddress
     * @returns {boolean}
     */
    isBanned(peerAddress) {
        const peerAddressState = this._addressList.get(peerAddress);
        return peerAddressState
            && peerAddressState.state === PeerAddressState.BANNED
            // XXX Never consider seed peers to be banned. This allows us to use
            // the banning mechanism to prevent seed peers from being picked when
            // they are down, but still allows recovering seed peers' inbound
            // connections to succeed.
            && !peerAddressState.peerAddress.isSeed();
    }

    /**
     * @param {PeerAddress} peerAddress
     * @returns {void}
     * @private
     */
    _remove(peerAddress) {
        const peerAddressState = this._addressList.get(peerAddress);
        if (!peerAddressState) {
            return;
        }

        // Never delete seed addresses, ban them instead for a couple of minutes.
        if (peerAddressState.peerAddress.isSeed()) {
            this.ban(peerAddress, peerAddressState.banBackoff);
            return;
        }

        // Delete from peerId index.
        if (peerAddress.protocol === Protocol.RTC) {
            this._addressList.removePeerId(peerAddress.peerId);
        }

        if (peerAddressState.state === PeerAddressState.CONNECTING) {
            this._addressList.connectingCount--;
        }

        // Don't delete bans.
        if (peerAddressState.state === PeerAddressState.BANNED) {
            return;
        }

        // Delete the address.
        this._addressList.remove(peerAddress);
    }

    /**
     * Delete all RTC-only routes that are signalable over the given peer.
     * @param {PeerChannel} channel
     * @returns {void}
     * @private
     */
    _removeBySignalChannel(channel) {
        // XXX inefficient linear scan
        for (const peerAddressState of this._addressList.values()) {
            if (peerAddressState.peerAddress.protocol === Protocol.RTC) {
                peerAddressState.deleteRoute(channel);
                if (!peerAddressState.hasRoute()) {
                    this._remove(peerAddressState.peerAddress);
                }
            }
        }
    }


    /**
     * @returns {void}
     * @private
     */
    _housekeeping() {
        const now = Date.now();
        const unbannedAddresses = [];

        for (/** @type {PeerAddressState} */ const peerAddressState of this._addressList.values()) {
            const addr = peerAddressState.peerAddress;

            switch (peerAddressState.state) {
                case PeerAddressState.NEW:
                case PeerAddressState.TRIED:
                case PeerAddressState.FAILED:
                    // Delete all new peer addresses that are older than MAX_AGE.
                    if (addr.exceedsAge()) {
                        Log.d(PeerAddressBook, `Deleting old peer address ${addr}`);
                        this._remove(addr);
                    }

                    // Reset failed attempts after bannedUntil has expired.
                    if (peerAddressState.state === PeerAddressState.FAILED
                        && peerAddressState.failedAttempts >= peerAddressState.maxFailedAttempts
                        && peerAddressState.bannedUntil > 0 && peerAddressState.bannedUntil <= now) {

                        peerAddressState.bannedUntil = -1;
                        peerAddressState.failedAttempts = 0;
                    }
                    
                    break;

                case PeerAddressState.BANNED:
                    if (peerAddressState.bannedUntil <= now) {
                        // If we banned because of failed attempts or it is a seed node, try again.
                        if (peerAddressState.failedAttempts >= peerAddressState.maxFailedAttempts || addr.isSeed()) {
                            // Restore banned seed addresses to the NEW state.
                            peerAddressState.state = PeerAddressState.NEW;
                            peerAddressState.failedAttempts = 0;
                            peerAddressState.bannedUntil = -1;
                            unbannedAddresses.push(addr);
                        } else {
                            // Delete expires bans.
                            this._addressList.store.remove(addr);
                        }
                    }
                    break;

                case PeerAddressState.CONNECTED:
                    // Also update timestamp for RTC connections
                    if (peerAddressState.bestRoute) {
                        peerAddressState.bestRoute.timestamp = now;
                    }
                    break;

                default:
                    // TODO What about peers who are stuck connecting? Can this happen?
                    // Do nothing for CONNECTING peers.
            }
        }

        if (unbannedAddresses.length) {
            this.fire('added', unbannedAddresses, this);
        }
    }

    /**
     * @param {PeerAddress} peerAddress
     * @param {function} caller
     * @param {Object} payload
     * @returns {PeerAddressState|null}
     */
    _transition(peerAddress, caller, payload={}) {
        // Request caller function (does not work in strict mode)
        // const caller = this._transition.caller;
    
        // Shortcut on empty peerAddress
        if ([PeerAddressBook.unroutable].includes(caller)) {
            if (!peerAddress) {
                return null;
            }
        }

        let peerAddressState = this._addressList.get(peerAddress);

        // Handling the absence of a peerAddressState
        if ([PeerAddressBook.prototype.connecting,
            PeerAddressBook.prototype.disconnected,
            PeerAddressBook.prototype.failure,
            PeerAddressBook.prototype.unroutable].includes(caller)) {
            if (!peerAddressState) {
                return null;
            }
        }
        else if (PeerAddressBook.prototype.connected === caller) {
            if (!peerAddressState) {
                peerAddressState = new PeerAddressState(peerAddress);
    
                if (peerAddress.protocol === Protocol.RTC) {
                    this._addressList.putPeerId(peerAddress.peerId, peerAddressState);
                }
    
                this._addressList.add(peerAddressState);
            }    
        }
        else if (PeerAddressBook.prototype.ban == caller) {
            if (!peerAddressState) {
                peerAddressState = new PeerAddressState(peerAddress);
                this._addressList.add(peerAddressState);
            }    
        }
 
        // Disconnect channel
        if ([PeerAddressBook.prototype.disconnected].includes(caller)) {
            if (payload.channel) {
                this._removeBySignalChannel(payload.channel);
            }
        }

        // Reduce the state
        peerAddressState = peerAddressState.reduce(caller, this._addressList);
        if (!peerAddressState){
            return null;
        }

        // Individual additional behaviour
        if ([PeerAddressBook.prototype.connected].includes(caller)) {
            peerAddressState.lastConnected = Date.now();
            peerAddressState.failedAttempts = 0;
            peerAddressState.banBackoff = PeerAddressBook.INITIAL_FAILED_BACKOFF;

            peerAddressState.peerAddress = peerAddress;

            // Add route.
            if (peerAddress.protocol === Protocol.RTC) {
                peerAddressState.addRoute(payload.channel, peerAddress.distance, peerAddress.timestamp);
            }
        }

        if ([PeerAddressBook.prototype.failure].includes(caller)) {
            peerAddressState.failedAttempts++;

            if (peerAddressState.failedAttempts >= peerAddressState.maxFailedAttempts) {
                // Remove address only if we have tried the maximum number of backoffs.
                if (peerAddressState.banBackoff >= PeerAddressBook.MAX_FAILED_BACKOFF) {
                    peerAddressState._remove(peerAddress);
                } else {
                    peerAddressState.ban(peerAddress, peerAddressState.banBackoff);
                    peerAddressState.banBackoff = Math.min(PeerAddressBook.MAX_FAILED_BACKOFF, peerAddressState.banBackoff * 2);
                }
            }
        }

        if ([PeerAddressBook.prototype.ban].includes(caller)) {
            peerAddressState.bannedUntil = Date.now() + payload.duration ? payload.duration : 0;

            // Drop all routes to this peer.
            peerAddressState.deleteAllRoutes();
        }

        if ([PeerAddressBook.prototype.disconnected].includes(caller)) {
            // XXX Immediately delete address if the remote host closed the connection.
            // Also immediately delete dumb clients, since we cannot connect to those anyway.
            if ((payload.channel.closedByRemote && PlatformUtils.isOnline()) || peerAddressState.peerAddress.protocol === Protocol.DUMB) {
                this._remove(peerAddress);
            }
        }

        if ([PeerAddressBook.prototype.unroutable].includes(caller)) {
            if (!peerAddressState.bestRoute || (payload.channel && !peerAddressState.bestRoute.signalChannel.equals(payload.channel))) {
                Log.w(PeerAddressBook, `Got unroutable for ${peerAddress} on a channel other than the best route.`);
                return null;
            }
    
            peerAddressState.deleteBestRoute();
            if (!peerAddressState.hasRoute()) {
                this._remove(peerAddressState.peerAddress);
            }
        }

        return peerAddressState;
    }
}
PeerAddressBook.MAX_AGE_WEBSOCKET = 1000 * 60 * 30; // 30 minutes
PeerAddressBook.MAX_AGE_WEBRTC = 1000 * 60 * 10; // 10 minutes
PeerAddressBook.MAX_AGE_DUMB = 1000 * 60; // 1 minute
PeerAddressBook.MAX_DISTANCE = 4;
PeerAddressBook.MAX_FAILED_ATTEMPTS_WS = 3;
PeerAddressBook.MAX_FAILED_ATTEMPTS_RTC = 2;
PeerAddressBook.MAX_TIMESTAMP_DRIFT = 1000 * 60 * 10; // 10 minutes
PeerAddressBook.HOUSEKEEPING_INTERVAL = 1000 * 60; // 1 minute
PeerAddressBook.DEFAULT_BAN_TIME = 1000 * 60 * 10; // 10 minutes
PeerAddressBook.INITIAL_FAILED_BACKOFF = 1000 * 15; // 15 seconds
PeerAddressBook.MAX_FAILED_BACKOFF = 1000 * 60 * 10; // 10 minutes
PeerAddressBook.SEED_PEERS = [
    // WsPeerAddress.seed('alpacash.com', 8080),
    // WsPeerAddress.seed('nimiq1.styp-rekowsky.de', 8080),
    // WsPeerAddress.seed('nimiq2.styp-rekowsky.de', 8080),
    // WsPeerAddress.seed('seed1.nimiq-network.com', 8080),
    // WsPeerAddress.seed('seed2.nimiq-network.com', 8080),
    // WsPeerAddress.seed('seed3.nimiq-network.com', 8080),
    // WsPeerAddress.seed('seed4.nimiq-network.com', 8080),
    // WsPeerAddress.seed('emily.nimiq-network.com', 443)
    WsPeerAddress.seed('dev.nimiq-network.com', 8080)
];
Class.register(PeerAddressBook);