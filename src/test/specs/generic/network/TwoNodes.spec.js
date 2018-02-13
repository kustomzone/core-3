describe('TwoNodes', () => {
    beforeEach(function () {
        MockNetwork.install();
    });

    afterEach(function () {
        MockNetwork.uninstall();
    });

    it('should be able to connect and reach consensus through WebSocket', (done) => {
        let established = false;

        function checkEstablished(){
            if (established) done();
            established = true;
        }

        (async () => {
            const netconfig = new WsNetworkConfig('node1.test', 9000, 'key1', 'cert1');
            const consensus1 = await Consensus.volatileFull(netconfig);
            consensus1.on('established', checkEstablished);

            PeerAddresses.SEED_PEERS = [WsPeerAddress.seed('node1.test', 9000)];

            const consensus2 = await Consensus.volatileFull();
            consensus2.on('established', checkEstablished);

            consensus2.network.connect();

            expect(true).toBe(true);
        })().catch(done.fail);
    });

    it('should be able to connect and sync through WebRTC', (done) => {
        let consensus3, established = false;

        function checkEstablished() {
            if (established) {
                expect(consensus3._agents.length).toBe(2);
                done();
            }
            established = true;
        }

        (async () => {
            const netconfig = new WsNetworkConfig('node1.test', 9000, 'key1', 'cert1');
            const consensus1 = await Consensus.volatileFull(netconfig);
            consensus1.on('established', checkEstablished);

            PeerAddresses.SEED_PEERS = [WsPeerAddress.seed('node1.test', 9000)];

            spyOn(PlatformUtils, 'supportsWebRTC').and.callFake(() => {
                return true;
            });

            const consensus2 = await Consensus.volatileFull();
            consensus2.network.connect();

            consensus2.on('established', async () => {
                consensus3 = await Consensus.volatileLight();
                consensus3.network.connect();
                consensus3.on('established', checkEstablished);
            });
        })().catch(done.fail);
    });
});
