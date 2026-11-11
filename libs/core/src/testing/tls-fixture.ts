/**
 * A self-signed certificate for `receiver.test`, for the https tests of the
 * safe HTTP client. It is for tests only: the key is public and protects
 * nothing. Node cannot create X.509 certificates itself, so it is committed.
 * Valid until 2126. To renew, run
 *
 *   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
 *     -keyout key.pem -out cert.pem -days 36500 -subj "/CN=receiver.test" \
 *     -addext "subjectAltName=DNS:receiver.test" \
 *     -addext "basicConstraints=critical,CA:FALSE"
 *
 * and paste the two files below.
 */
export const TLS_FIXTURE = {
  hostname: 'receiver.test',
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg7csL1RYb9uPcpyTO
kromz764ViX2QN6zgQ4ZDhLB6zuhRANCAAR1tzBpjXTSs8n/c/kg8QvRr4wBnPYB
9tsXpbGl5MqsbVNcUNbaqVFb9jL8g/Pa7jWLlYeAudVR92Knb3jCxzKc
-----END PRIVATE KEY-----
`,
  cert: `-----BEGIN CERTIFICATE-----
MIIBfTCCASOgAwIBAgIUTEhtl1teNaL8gYcRE4BXRQc1dRUwCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNcmVjZWl2ZXIudGVzdDAgFw0yNjExMTExNjI0MTRaGA8yMTI2
MTAxODE2MjQxNFowGDEWMBQGA1UEAwwNcmVjZWl2ZXIudGVzdDBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABHW3MGmNdNKzyf9z+SDxC9GvjAGc9gH22xelsaXkyqxt
U1xQ1tqpUVv2MvyD89ruNYuVh4C51VH3YqdveMLHMpyjSTBHMB0GA1UdDgQWBBT8
Lxyl7+/SoE22ViwY6k3qajFG5jAYBgNVHREEETAPgg1yZWNlaXZlci50ZXN0MAwG
A1UdEwEB/wQCMAAwCgYIKoZIzj0EAwIDSAAwRQIhAIi22ElNOLYh+IvUXNNm1Gz/
1kqkdeIVccNnT7SMrAQeAiBPvxSOSG2jEsoG5z2M5MFKLCss/cJpi5h/vK3qFWzE
AA==
-----END CERTIFICATE-----
`,
} as const;
