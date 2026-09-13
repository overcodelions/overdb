// Is this error the session dying, or the statement failing?
//
// The distinction is the whole basis of healing: a lost session can be
// replaced and the request re-issued, while a real error (bad SQL, a
// permission, a constraint) must reach the user untouched. Kept here, away
// from electron, so both the supervisor and a test can use it.

/// Every way the four drivers say "this connection is gone", plus the
/// supervisor's own wording for a host that died under a request.
///
/// mysql2 is the awkward one. When the socket dies while a command is in
/// flight, the error is handed to that command's callback and the
/// connection's 'error' event never fires (see _notifyError), so the
/// adapter's own "lost" flag stays clear and every later call comes back
/// with the driver's "Can't add new command when connection is in closed
/// state" — which is what this pattern is mostly here to catch.
///
/// The bare errnos are the wake-from-sleep cases. A laptop that slept, a
/// VPN that dropped or a Wi-Fi network that changed takes the interface the
/// socket was bound to with it, and libuv raises the failure on the driver's
/// socket with no wording of its own — `read EADDRNOTAVAIL` and friends
/// reach us as the in-flight query's rejection, before either adapter's
/// 'error' listener has latched a fatal, so this list is the only thing
/// that recognises them.
const LOST = [
  /connection is in closed state/i,
  /can't write in closed state/i,
  /connection was lost/i,
  /connection lost/i,
  /PROTOCOL_CONNECTION_LOST/,
  /server closed the connection/i,
  /connection terminated/i,
  /terminating connection due to/i,
  /client has encountered a connection error/i,
  // Not ECONNREFUSED, ENOTFOUND or EAI_AGAIN: those are a host we never
  // reached rather than a session we lost, so the replacement would fail to
  // connect too and healing would only delay an honest error.
  /ECONNRESET|EPIPE|ETIMEDOUT|ECONNABORTED|EADDRNOTAVAIL|EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|ENETDOWN/,
  /socket hang up/i,
  /adapter is not connected/i,
  /^not connected$/i,
  // The supervisor's own vocabulary for a host that went away mid-request.
  /connection host exited/i,
  /connection is not open/i,
  /^connection closed$/i,
];

export function isLostSession(message: string): boolean {
  return LOST.some((re) => re.test(message));
}
