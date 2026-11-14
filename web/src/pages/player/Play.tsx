// Participant entry: /join/:code and /play/:code. Join form if no stored token, else live room over WebSocket.
import { useEffect, useState } from 'preact/hooks';
import { getPlayer, clearPlayer } from '../../lib/storage';
import type { StoredPlayer } from '../../lib/storage';
import { navigate } from '../../lib/router';
import { useRoom } from '../../lib/ws';
import type { PlayerSnapshot } from '../../../../shared/protocol';
import { fixtureName, devFx } from '../../lib/fixtures';
import { JoinForm } from './Join';
import { Message, Shell, LiveShell } from './parts';
import { RoomView, Kicked } from './screens';
import type { ConnLike } from './screens';

export function Play(props: { code: string }) {
  const fx = import.meta.env.DEV ? fixtureName() : null; // dev-only fixtures (#14)
  if (fx) return <PlayFixture name={fx} code={props.code} />;
  return <PlayLive code={props.code} />;
}

function PlayLive({ code }: { code: string }) {
  const [player, setP] = useState<StoredPlayer | null>(() => getPlayer(code));
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (player && location.pathname !== `/play/${code}`) navigate(`/play/${code}`, true);
  }, [player, code]);

  if (gone) return <Message title="Quiz not found" body="This quiz has ended or the code is no longer active." home />;
  if (!player) {
    return <JoinForm code={code} onJoined={(p) => setP(p)} />;
  }
  return (
    <Connected key={player.token} code={code} player={player}
      onUnauthorized={() => { clearPlayer(code); setP(null); navigate(`/join/${code}`, true); }}
      onNotFound={() => { clearPlayer(code); setGone(true); }} />
  );
}

function Connected(props: { code: string; player: StoredPlayer; onUnauthorized: () => void; onNotFound: () => void }) {
  const { code, player } = props;
  const conn = useRoom<PlayerSnapshot>({ role: 'player', code, token: player.token });

  useEffect(() => {
    if (conn.fatal === 'unauthorized') props.onUnauthorized();
    else if (conn.fatal === 'not_found') props.onNotFound();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.fatal]);

  if (conn.fatal === 'kicked') return <Kicked />;
  if (!conn.snap) {
    return (
      <LiveShell title="Cloud 9" score={null} status={conn.status === 'connecting' ? 'open' : conn.status}>
        <div class="c9-p-center c9-p-stack">
          <div class="c9-p-spinner" aria-hidden="true" />
          <p class="c9-muted">{conn.status === 'reconnecting' ? 'Trying to reconnect…' : `Connecting as ${player.name}…`}</p>
        </div>
      </LiveShell>
    );
  }
  return <RoomView snap={conn.snap} conn={conn} />;
}

function PlayFixture({ name, code }: { name: string; code: string }) {
  const { playerFixture, joinFixture, joinEventFixture } = devFx()!;
  const [snap] = useState(() => playerFixture(name));
  if (name === 'join-form') return <JoinForm code={joinFixture.code} fixtureInfo={joinFixture} onJoined={() => {}} />;
  if (name === 'join-email-required') return <JoinForm code={joinEventFixture.code} fixtureInfo={joinEventFixture} onJoined={() => {}} />;
  if (name === 'kicked') return <Kicked />;
  if (name === 'not-found') return <Message title="Quiz not found" body={`There's no live quiz with the code ${code}. Check the code on the screen and try again.`} home />;
  if (!snap) return <Shell><p class="c9-p-center">Unknown fixture "{name}"</p></Shell>;
  const off = new URLSearchParams(location.search).get('conn') === 'off';
  const conn: ConnLike = { status: off ? 'reconnecting' : 'open', now: () => Date.now(), send: () => true };
  return <RoomView snap={snap} conn={conn} />;
}
