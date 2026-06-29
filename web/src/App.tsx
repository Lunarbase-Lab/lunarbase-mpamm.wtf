import { TopBar } from './components/TopBar';
import { useDashboard } from './store';
import { ExecutionTab } from './tabs/Execution';
import { VolumeTab } from './tabs/Volume';
import { MarkoutsTab } from './tabs/Markouts';
import { LeaderboardTab } from './tabs/Leaderboard';

export function App() {
  const { tab } = useDashboard();
  return (
    <div>
      <TopBar />
      {tab === 'exec' && <ExecutionTab />}
      {tab === 'volume' && <VolumeTab />}
      {tab === 'markouts' && <MarkoutsTab />}
      {tab === 'leaderboard' && <LeaderboardTab />}
    </div>
  );
}
