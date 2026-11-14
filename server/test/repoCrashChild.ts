// Child process for repo.test.ts "hard crash" test: writes answers through the given path, then dies with SIGKILL
// (no flush, no close). Usage: tsx repoCrashChild.ts <dbPath> <record|legacy> <n>
import { openRepo } from '../src/db/repo';

const [dbPath, mode, nStr] = process.argv.slice(2);
const n = Number(nStr);
const repo = openRepo(dbPath);
for (let i = 0; i < n; i++) {
  const a = { sessionId: 's1', playerId: `p${i}`, questionId: 'q1', qIndex: 0, choice: 1, correct: true, responseMs: 1000 + i, points: 500 + i, answeredAt: 5000 + i };
  if (mode === 'record') {
    repo.recordAnswer(a, a.playerId, a.points);
  } else {
    // the pre-fix path: score written immediately, row buffered for the 100 ms flush
    repo.updatePlayer(a.playerId, { score: a.points });
    repo.queueAnswer(a);
  }
}
process.stdout.write('written\n');
process.kill(process.pid, 'SIGKILL');
