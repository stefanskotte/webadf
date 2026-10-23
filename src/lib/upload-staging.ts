// The A6 Upload staging model (client-safe, types only).
export type ServerRow = {
  source: 'server';
  key: string;                                   // 'send:<id>' | 'amiga:<id>'
  kind: 'out' | 'in';
  id: string;
  name: string;                                  // send: path; amiga: path
  sizeBytes: number;
  board: { id: string | null; name: string };
  status: 'queued' | 'sending' | 'delivered' | 'failed' | 'cancelled' | 'expired' | 'receiving' | 'stored';
  doneBytes: number;                             // bytesSent / receivedBytes
  pct: number | null;                            // sending/receiving: min(99, floor(done*100/size)); else null
  savedAs: string | null;
  error: string | null;                          // failed: failureText / uploadFailureText; else null
  isDiskImage: boolean;                          // amiga: libraryEligible(path, size); send: false
  title: { gameId: string; title: string } | null;
  at: number;                                    // createdAt ms
};
