/**
 * /how-to-play: public rules summary (D69). Keep in step with docs/GAME_RULES.md.
 */

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from 'deepspace'
import { Swords, Timer, Trophy, Vote, Zap, Hourglass } from 'lucide-react'
import { buttonVariants, cn } from '@/components/ui'
import { Panel } from '../../components/game/bits'

export default function HowToPlayPage() {
  const { isSignedIn } = useAuth()
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 px-4 pb-16 pt-6" data-testid="how-to-play">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">SkillClash</p>
        <h1 className="font-display mt-1 text-4xl font-extrabold uppercase italic leading-none">How to play</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Challenge someone by username. You both film short clips (up to 20 seconds) of a skill, and the crowd votes on who did it better.
        </p>
      </header>

      <Rule icon={<Swords className="size-5 text-primary" aria-hidden />} title="Standard: 3 rounds">
        <Steps>
          <li>
            <b>Round 1, your skill.</b> You name a skill and film it to send the challenge. Your opponent films their match.
          </li>
          <li>
            <b>Round 2, their skill.</b> To accept, your opponent names a different skill and films it. You film your match.
          </li>
          <li>
            <b>Round 3, freestyle.</b> You each pick your own skill and film it. Both clips stay hidden until both are in or time runs out.
          </li>
        </Steps>
        <Bullets>
          <li>
            <b>Blind picks:</b> the invite shows who challenged you, never their skill. Each skill is revealed when its round opens.
          </li>
          <li>
            <b>Setter films first,</b> the opponent matches: 12 hours to film, then 3 hours of voting per round.
          </li>
        </Bullets>
      </Rule>

      <Rule icon={<Timer className="size-5 text-primary" aria-hidden />} title="Rapid Fire: 1 round">
        <Bullets>
          <li>You name a skill and film it to challenge.</li>
          <li>
            <b>5 minutes</b> to accept. Accepting starts the clock: <b>5 minutes</b> to film the match.
          </li>
          <li>
            <b>15 minutes</b> of voting. No battle bonus.
          </li>
        </Bullets>
      </Rule>

      <Rule icon={<Vote className="size-5 text-primary" aria-hidden />} title="Voting">
        <Bullets>
          <li>Anyone signed in can vote, except the two players.</li>
          <li>One vote per round.</li>
          <li>Vote counts stay hidden until voting closes.</li>
        </Bullets>
      </Rule>

      <Rule icon={<Trophy className="size-5 text-primary" aria-hidden />} title="Scoring">
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm">
          <Row label="Round win" value="+10" />
          <Row label="Round tie (each)" value="+5" />
          <Row label="Zero votes" value="Tie" />
          <Row label="Missed deadline" value="Opponent wins the round" />
          <Row label="Battle win bonus (Standard)" value="+10" />
          <Row label="Battle tie bonus (Standard, each)" value="+5" />
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">Points add up on your profile.</p>
      </Rule>

      <Rule icon={<Zap className="size-5 text-primary" aria-hidden />} title="Energy">
        <Bullets>
          <li>
            Up to <b>5 energy</b>. Sending a challenge costs 1. Accepting is free.
          </li>
          <li>+1 every 5 hours while you're below 5.</li>
          <li>Your energy comes back if the challenge is declined, cancelled or expires.</li>
          <li>Win a battle: +1.</li>
        </Bullets>
      </Rule>

      <Rule icon={<Hourglass className="size-5 text-primary" aria-hidden />} title="Invites expire">
        <Bullets>
          <li>
            An unanswered invite expires after <b>24 hours</b> (Standard) or <b>5 minutes</b> (Rapid Fire).
          </li>
          <li>You can cancel your own invite until it's answered.</li>
        </Bullets>
      </Rule>

      {isSignedIn && (
        <Link to="/challenge" className={cn(buttonVariants({ size: 'lg' }), 'w-full font-semibold')}>
          <Swords className="size-4" aria-hidden /> New challenge
        </Link>
      )}
    </div>
  )
}

function Rule({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Panel className="p-4">
      <h2 className="font-display mb-2 flex items-center gap-2 text-xl font-extrabold uppercase italic tracking-wide">
        {icon} {title}
      </h2>
      <div className="space-y-2">{children}</div>
    </Panel>
  )
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="list-decimal space-y-1.5 pl-5 text-sm marker:font-bold marker:text-primary">{children}</ol>
}

function Bullets({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5 text-sm marker:text-muted-foreground">{children}</ul>
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-semibold">{value}</dd>
    </>
  )
}
