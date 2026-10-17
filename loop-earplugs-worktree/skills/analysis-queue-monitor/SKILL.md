---
name: analysis-queue-monitor
description: >-
  Reports the analysis queue every 5 minutes from bin/orchestrator status:
  who holds each stage, the next 5 sites, the queue length, live workers,
  and any STALLED stage. Use when the user says to monitor, watch, or check
  the queue on a loop.
---

# Monitor the analysis queue

Read [CONTRACT.md](../analysis-queue/CONTRACT.md). This skill reports the queue. It does not start a worker, change a priority, retry, or clear anything.

The schedule is the local fixed loop in the loop skill (monitored shell output). Use a 5-minute interval.

## Arm it

1. Check the terminals already open for a loop whose output contains `AGENT_LOOP_TICK_queue`. If one is running, do not start another. Report once now, and say the existing loop is still armed.
2. Start one background loop from the repo root. Title it `Loop every 5m: queue status`. Set `notify_on_output` to the pattern `^AGENT_LOOP_TICK_queue` and a reason of `Queue monitor tick`.

```bash
while true; do
  sleep 300
  echo 'AGENT_LOOP_TICK_queue {"prompt":"Queue monitor tick. Run bin/orchestrator status from the analysis-engine repo. Tell the user who holds each stage, the next 5 sites, the queue length, the live workers, and any STALLED stage. Do not start or change queued work."}'
done
```

3. Confirm the process started and record its pid.
4. Run the report once immediately. The first sentinel arrives only after the initial 5-minute sleep, so this run is the first report.

## Each report

Run, from the repo root:

```bash
bin/orchestrator status
```

Tell the user what it says:

- each stage that has a job: the domain, the attempt (and the fallback agent and attempt, when one is working), and the worker;
- each empty stage, briefly, or "all other stages are empty";
- the next 5 jobs, with priority and the stage each waits for;
- the queue length line: in a stage, waiting, done, blocked, failed, cancelled, dead letters;
- the live workers.

Lead with any `STALLED` line. A lease held by a worker with no recent heartbeat means that worker died mid-stage; its lease expires and another worker takes the job. Ready work with no live worker means nobody is running the queue; say that `bin/orchestrator start` would start one, and leave it to the user.

For a blocked or failed job, run `bin/orchestrator show <job>` and give the blocker in one line.

On a later tick, add one line on what changed since the previous report: still on the same stage, a new stage, a finished site, a block or failure, or a change in length. Do not start work from a tick.

## Stop

When the user says to stop monitoring, kill the tracked pid, then wait for that shell to finish so its completion notice does not wake another report. Say that the loop has stopped.
