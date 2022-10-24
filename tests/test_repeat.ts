import { expect } from 'chai';
import { default as IORedis } from 'ioredis';
import { beforeEach, describe, it } from 'mocha';
import * as sinon from 'sinon';
import { v4 } from 'uuid';
import { rrulestr } from 'rrule';
import {
  Job,
  Queue,
  QueueEvents,
  Repeat,
  getNextMillis,
  Worker,
} from '../src/classes';
import { JobsOptions } from '../src/types';
import { removeAllQueueData } from '../src/utils';

const moment = require('moment');

const ONE_SECOND = 1000;
const ONE_MINUTE = 60 * ONE_SECOND;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;

const NoopProc = async (job: Job) => {};

describe('repeat', function () {
  this.timeout(10000);
  let repeat: Repeat;
  let queue: Queue;
  let queueEvents: QueueEvents;
  let queueName: string;

  const connection = { host: 'localhost' };

  beforeEach(function () {
    this.clock = sinon.useFakeTimers();
  });

  beforeEach(async function () {
    queueName = `test-${v4()}`;
    queue = new Queue(queueName, { connection });
    repeat = new Repeat(queueName, { connection });
    queueEvents = new QueueEvents(queueName, { connection });
    await queueEvents.waitUntilReady();
  });

  afterEach(async function () {
    this.clock.restore();
    await queue.close();
    await repeat.close();
    await queueEvents.close();
    await removeAllQueueData(new IORedis(), queueName);
  });

  it('it should stop repeating after endDate', async function () {
    const every = 100;
    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);
    const worker = new Worker(
      queueName,
      async () => {
        this.clock.tick(every);
      },
      { connection },
    );
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});
    await worker.waitUntilReady();

    let processed = 0;
    const completing = new Promise<void>(resolve => {
      worker.on('completed', async () => {
        processed++;
        if (processed === 10) {
          resolve();
        }
      });
    });

    const job = await queue.add(
      'test',
      { foo: 'bar' },
      {
        repeat: {
          endDate: Date.now() + 1000,
          every: 100,
        },
      },
    );

    expect(job.repeatJobKey).to.not.be.undefined;

    this.clock.tick(every + 1);

    await completing;

    const delayed = await queue.getDelayed();

    expect(delayed).to.have.length(0);
    expect(processed).to.be.equal(10);

    await worker.close();
    delayStub.restore();
  });

  it('should create multiple jobs if they have the same cron pattern', async function () {
    const cron = '*/10 * * * * *';

    await Promise.all([
      queue.add('test1', {}, { repeat: { pattern: cron } }),
      queue.add('test2', {}, { repeat: { pattern: cron } }),
      queue.add('test3', {}),
    ]);

    const count = await queue.count();
    expect(count).to.be.eql(3);
  });

  it('should get repeatable jobs with different cron pattern', async function () {
    const crons = [
      '10 * * * * *',
      '2 10 * * * *',
      '1 * * 5 * *',
      '2 * * 4 * *',
    ];

    await Promise.all([
      queue.add('first', {}, { repeat: { pattern: crons[0], endDate: 12345 } }),
      queue.add(
        'second',
        {},
        { repeat: { pattern: crons[1], endDate: 610000 } },
      ),
      queue.add(
        'third',
        {},
        { repeat: { pattern: crons[2], tz: 'Africa/Abidjan' } },
      ),
      queue.add(
        'fourth',
        {},
        { repeat: { pattern: crons[3], tz: 'Africa/Accra' } },
      ),
      queue.add(
        'fifth',
        {},
        { repeat: { every: 5000, tz: 'Europa/Copenhaguen' } },
      ),
    ]);
    const count = await repeat.getRepeatableCount();
    expect(count).to.be.eql(5);

    let jobs = await repeat.getRepeatableJobs(0, -1, true);
    jobs = await jobs.sort(function (a, b) {
      return crons.indexOf(a.cron) - crons.indexOf(b.cron);
    });
    expect(jobs)
      .to.be.and.an('array')
      .and.have.length(5)
      .and.to.deep.include({
        key: 'first::12345::10 * * * * *',
        name: 'first',
        id: null,
        endDate: 12345,
        tz: null,
        pattern: '10 * * * * *',
        next: 10000,
      })
      .and.to.deep.include({
        key: 'second::610000::2 10 * * * *',
        name: 'second',
        id: null,
        endDate: 610000,
        tz: null,
        pattern: '2 10 * * * *',
        next: 602000,
      })
      .and.to.deep.include({
        key: 'fourth:::Africa/Accra:2 * * 4 * *',
        name: 'fourth',
        id: null,
        endDate: null,
        tz: 'Africa/Accra',
        pattern: '2 * * 4 * *',
        next: 259202000,
      })
      .and.to.deep.include({
        key: 'third:::Africa/Abidjan:1 * * 5 * *',
        name: 'third',
        id: null,
        endDate: null,
        tz: 'Africa/Abidjan',
        pattern: '1 * * 5 * *',
        next: 345601000,
      });
  });

  it('should repeat every 2 seconds', async function () {
    this.timeout(20000);

    const nextTick = 2 * ONE_SECOND + 100;

    const worker = new Worker(
      queueName,
      async () => {
        this.clock.tick(nextTick);
      },
      { connection },
    );
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);

    await queue.add(
      'test',
      { foo: 'bar' },
      { repeat: { pattern: '*/2 * * * * *' } },
    );

    this.clock.tick(nextTick);

    let prev: any;
    let counter = 0;

    const completing = new Promise<void>(resolve => {
      worker.on('completed', async job => {
        if (prev) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          expect(job.timestamp - prev.timestamp).to.be.gte(2000);
        }
        prev = job;
        counter++;
        if (counter == 5) {
          resolve();
        }
      });
    });

    await completing;
    await worker.close();
    delayStub.restore();
  });

  it('should repeat every 2 seconds with startDate in future', async function () {
    this.timeout(200000);

    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);
    const nextTick = 2 * ONE_SECOND + 500;
    const delay = 5 * ONE_SECOND + 500;

    const worker = new Worker(
      queueName,
      async () => {
        this.clock.tick(nextTick);
      },
      { connection },
    );
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

    await queue.add(
      'test',
      { foo: 'bar' },
      {
        repeat: {
          pattern: '*/2 * * * * *',
          startDate: new Date('2017-02-07 9:24:05'),
        },
      },
    );

    this.clock.tick(nextTick + delay);

    let prev: Job;
    let counter = 0;

    const completing = new Promise<void>((resolve, reject) => {
      worker.on('completed', async job => {
        if (prev) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          expect(job.timestamp - prev.timestamp).to.be.gte(2000);
        }
        prev = job;
        counter++;
        if (counter == 5) {
          resolve();
        }
      });
    });

    await completing;

    await worker.close();
    delayStub.restore();
  });

  it('should repeat every 2 seconds with startDate in past', async function () {
    this.timeout(100000);

    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);
    const nextTick = 2 * ONE_SECOND + 500;
    const delay = 5 * ONE_SECOND + 500;

    const worker = new Worker(
      queueName,
      async () => {
        this.clock.tick(nextTick);
      },
      { connection },
    );
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

    await queue.add(
      'repeat',
      { foo: 'bar' },
      {
        repeat: {
          pattern: '*/2 * * * * *',
          startDate: new Date('2017-02-07 9:22:00'),
        },
      },
    );

    this.clock.tick(nextTick + delay);

    let prev: Job;
    let counter = 0;

    const completing = new Promise<void>((resolve, reject) => {
      worker.on('completed', async job => {
        if (prev) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          expect(job.timestamp - prev.timestamp).to.be.gte(2000);
        }
        prev = job;
        counter++;
        if (counter == 5) {
          resolve();
        }
      });
    });

    await completing;
    await worker.close();
    delayStub.restore();
  });

  it('should remove repeated job when using removeOnComplete', async function () {
    this.timeout(20000);
    const queueName2 = `test-${v4()}`;
    const queue2 = new Queue(queueName2, {
      connection,
      defaultJobOptions: {
        removeOnComplete: true,
      },
    });

    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);
    const nextTick = 2 * ONE_SECOND + 500;
    const delay = 5 * ONE_SECOND + 500;

    const worker = new Worker(
      queueName,
      async () => {
        this.clock.tick(nextTick);
      },
      { connection },
    );
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

    await queue.add(
      'test',
      { foo: 'bar' },
      {
        repeat: {
          pattern: '*/2 * * * * *',
          startDate: new Date('2017-02-07 9:24:05'),
        },
      },
    );

    this.clock.tick(nextTick + delay);

    let prev: Job;
    let counter = 0;

    const completing = new Promise<void>((resolve, reject) => {
      worker.on('completed', async job => {
        if (prev) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          expect(job.timestamp - prev.timestamp).to.be.gte(2000);
        }
        prev = job;
        counter++;
        if (counter == 5) {
          const counts = await queue2.getJobCounts('completed');
          expect(counts.completed).to.be.equal(0);
          resolve();
        }
      });
    });

    await completing;

    await queue2.close();
    await worker.close();
    await removeAllQueueData(new IORedis(), queueName2);
    delayStub.restore();
  });

  describe('when custom cron strategy is provided', function () {
    it('should repeat every 2 seconds', async function () {
      this.timeout(20000);
      const settings = {
        repeatStrategy: (millis, opts) => {
          const currentDate =
            opts.startDate && new Date(opts.startDate) > new Date(millis)
              ? new Date(opts.startDate)
              : new Date(millis);
          const rrule = rrulestr(opts.pattern);
          if (rrule.origOptions.count && !rrule.origOptions.dtstart) {
            throw new Error('DTSTART must be defined to use COUNT with rrule');
          }

          const next_occurrence = rrule.after(currentDate, false);
          return next_occurrence?.getTime();
        },
      };
      const currentQueue = new Queue(queueName, { connection, settings });

      const nextTick = 2 * ONE_SECOND + 100;

      const worker = new Worker(
        queueName,
        async () => {
          this.clock.tick(nextTick);
        },
        { connection, settings },
      );
      const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

      const date = new Date('2017-02-07 9:24:00');
      this.clock.setSystemTime(date);

      await currentQueue.add(
        'test',
        { foo: 'bar' },
        {
          repeat: {
            pattern: 'RRULE:FREQ=SECONDLY;INTERVAL=2;WKST=MO',
          },
        },
      );

      this.clock.tick(nextTick);

      let prev: any;
      let counter = 0;

      const completing = new Promise<void>(resolve => {
        worker.on('completed', async job => {
          if (prev) {
            expect(prev.timestamp).to.be.lt(job.timestamp);
            expect(job.timestamp - prev.timestamp).to.be.gte(2000);
          }
          prev = job;
          counter++;
          if (counter == 5) {
            resolve();
          }
        });
      });

      await completing;
      await currentQueue.close();
      await worker.close();
      delayStub.restore();
    });

    describe('when differentiating strategy by job name', function () {
      it('should repeat every 2 seconds', async function () {
        this.timeout(10000);
        const settings = {
          repeatStrategy: (millis, opts, name) => {
            if (name === 'rrule') {
              const currentDate =
                opts.startDate && new Date(opts.startDate) > new Date(millis)
                  ? new Date(opts.startDate)
                  : new Date(millis);
              const rrule = rrulestr(opts.pattern);
              if (rrule.origOptions.count && !rrule.origOptions.dtstart) {
                throw new Error(
                  'DTSTART must be defined to use COUNT with rrule',
                );
              }

              const next_occurrence = rrule.after(currentDate, false);
              return next_occurrence?.getTime();
            } else {
              return getNextMillis(millis, opts);
            }
          },
        };
        const currentQueue = new Queue(queueName, { connection, settings });

        const nextTick = 2 * ONE_SECOND + 100;

        const worker = new Worker(
          queueName,
          async () => {
            this.clock.tick(nextTick);
          },
          { connection, settings },
        );
        const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

        const date = new Date('2017-02-07 9:24:00');
        this.clock.setSystemTime(date);

        const repeat = {
          pattern: 'RRULE:FREQ=SECONDLY;INTERVAL=2;WKST=MO',
        };
        await currentQueue.add(
          'rrule',
          { foo: 'bar' },
          {
            repeat,
          },
        );

        this.clock.tick(nextTick);

        let prev: any;
        let counter = 0;

        const completing = new Promise<void>(resolve => {
          worker.on('completed', async job => {
            if (prev) {
              expect(prev.timestamp).to.be.lt(job.timestamp);
              expect(job.timestamp - prev.timestamp).to.be.gte(2000);
            }
            prev = job;
            counter++;
            if (counter == 5) {
              const removed = await queue.removeRepeatable('rrule', repeat);
              expect(removed).to.be.true;

              resolve();
            }
          });
        });

        await completing;

        let prev2: Job;
        let counter2 = 0;

        const completing2 = new Promise<void>(resolve => {
          worker.on('completed', async job => {
            if (prev2) {
              expect(prev2.timestamp).to.be.lt(job.timestamp);
              expect(job.timestamp - prev2.timestamp).to.be.gte(2000);
            }
            prev2 = job;
            counter2++;
            if (counter2 == 5) {
              resolve();
            }
          });
        });

        await queue.add(
          'test',
          { foo: 'bar' },
          {
            repeat: {
              pattern: '*/2 * * * * *',
              startDate: new Date('2017-02-07 9:24:05'),
            },
          },
        );

        this.clock.tick(nextTick);

        await completing2;

        await currentQueue.close();
        await worker.close();
        delayStub.restore();
      });
    });
  });

  it('should repeat every 2 seconds and start immediately', async function () {
    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);
    const nextTick = 2 * ONE_SECOND;

    const worker = new Worker(
      queueName,
      async () => {
        this.clock.tick(nextTick);
      },
      { connection },
    );
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

    let prev: Job;
    let counter = 0;

    const completing = new Promise<void>(resolve => {
      worker.on('completed', async job => {
        if (prev && counter === 1) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          expect(job.timestamp - prev.timestamp).to.be.gte(100);
        } else if (prev) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          expect(job.timestamp - prev.timestamp).to.be.gte(2000);
        }
        prev = job;
        counter++;
        if (counter === 5) {
          resolve();
        }
      });
    });

    await queue.add(
      'repeat',
      { foo: 'bar' },
      {
        repeat: {
          every: 2000,
          immediately: true,
        },
      },
    );

    this.clock.tick(100);

    await completing;
    await worker.close();
    delayStub.restore();
  });

  it('should repeat once a day for 5 days and start immediately', async function () {
    this.timeout(10000);

    const date = new Date('2017-05-05 13:12:00');
    this.clock.setSystemTime(date);

    const nextTick = ONE_DAY + 10 * ONE_SECOND;
    const delay = 5 * ONE_SECOND + 500;

    const worker = new Worker(
      queueName,
      async () => {
        this.clock.tick(nextTick);
      },
      { connection },
    );
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {
      console.log('delay');
    });

    let prev: Job;
    let counter = 0;
    const completing = new Promise<void>((resolve, reject) => {
      worker.on('completed', async job => {
        if (counter === 1) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          expect(job.timestamp - prev.timestamp).to.be.gte(delay);
        } else if (prev) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          expect(job.timestamp - prev.timestamp).to.be.gte(ONE_DAY);
        }
        prev = job;

        counter++;
        if (counter == 5) {
          resolve();
        }
      });
    });

    await queue.add(
      'repeat',
      { foo: 'bar' },
      {
        repeat: {
          pattern: '0 1 * * *',
          immediately: true,
          endDate: new Date('2017-05-10 13:13:00'),
        },
      },
    );
    this.clock.tick(delay);

    await completing;
    await worker.close();
    delayStub.restore();
  });

  it('should repeat once a day for 5 days', async function () {
    this.timeout(10000);

    const date = new Date('2017-05-05 13:12:00');
    this.clock.setSystemTime(date);

    const nextTick = ONE_DAY + 10 * ONE_SECOND;
    const delay = 5 * ONE_SECOND + 500;

    const worker = new Worker(
      queueName,
      async () => {
        this.clock.tick(nextTick);
      },
      { connection },
    );
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {
      console.log('delay');
    });

    await queue.add(
      'repeat',
      { foo: 'bar' },
      {
        repeat: {
          pattern: '0 1 * * *',
          endDate: new Date('2017-05-10 13:13:00'),
        },
      },
    );
    this.clock.tick(nextTick + delay);

    let prev: Job;
    let counter = 0;
    const completing = new Promise<void>((resolve, reject) => {
      worker.on('completed', async job => {
        if (prev) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          expect(job.timestamp - prev.timestamp).to.be.gte(ONE_DAY);
        }
        prev = job;

        counter++;
        if (counter == 5) {
          resolve();
        }
      });
    });

    await completing;
    await worker.close();
    delayStub.restore();
  });

  describe('when utc option is provided', function () {
    it('repeats once a day for 5 days', async function () {
      this.timeout(10000);

      const date = new Date('2017-05-05 13:12:00');
      this.clock.setSystemTime(date);

      const nextTick = ONE_DAY + 10 * ONE_SECOND;
      const delay = 5 * ONE_SECOND + 500;

      const worker = new Worker(
        queueName,
        async () => {
          this.clock.tick(nextTick);
        },
        { connection },
      );
      const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {
        console.log('delay');
      });

      let prev: Job;
      let counter = 0;
      const completing = new Promise<void>((resolve, reject) => {
        worker.on('completed', async job => {
          console.log('Completed!', job.id);
          try {
            if (prev) {
              expect(prev.timestamp).to.be.lt(job.timestamp);
              expect(job.timestamp - prev.timestamp).to.be.gte(ONE_DAY);
            }
            prev = job;

            counter++;
            if (counter == 5) {
              resolve();
            }
          } catch (err) {
            reject(err);
          }
        });
      });

      await queue.add(
        'repeat',
        { foo: 'bar' },
        {
          repeat: {
            pattern: '0 1 * * *',
            endDate: new Date('2017-05-10 13:13:00'),
            tz: 'Europe/Athens',
            utc: true,
          },
        },
      );
      this.clock.tick(nextTick + delay);

      await completing;
      await worker.close();
      delayStub.restore();
    });
  });

  it('should repeat 7:th day every month at 9:25', async function () {
    this.timeout(200000);

    const date = new Date('2017-02-02 7:21:42');
    this.clock.setSystemTime(date);

    const nextTick = () => {
      const now = moment();
      const nextMonth = moment().add(1, 'months');
      this.clock.tick(nextMonth - now);
    };

    const worker = new Worker(
      queueName,
      async () => {
        nextTick();
      },
      { connection },
    );
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

    await queue.add(
      'repeat',
      { foo: 'bar' },
      { repeat: { pattern: '* 25 9 7 * *' } },
    );
    nextTick();

    let counter = 10;
    let prev: Job;
    const completing = new Promise<void>(resolve => {
      worker.on('completed', async job => {
        if (prev) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          const diff = moment(job.timestamp).diff(
            moment(prev.timestamp),
            'months',
            true,
          );
          expect(diff).to.be.gte(1);
        }
        prev = job;

        counter--;
        if (counter == 0) {
          resolve();
        }
      });
    });

    await completing;
    await worker.close();
    delayStub.restore();
  });

  describe('when 2 jobs with the same options are added', function () {
    it('creates only one job', async function () {
      const options = {
        repeat: {
          pattern: '0 1 * * *',
        },
      };

      const p1 = queue.add('test', { foo: 'bar' }, options);
      const p2 = queue.add('test', { foo: 'bar' }, options);

      const jobs = await Promise.all([p1, p2]);
      const configs = await repeat.getRepeatableJobs(0, -1, true);

      const count = await queue.count();

      expect(count).to.be.equal(1);
      expect(configs).to.have.length(1);
      expect(jobs.length).to.be.eql(2);
      expect(jobs[0].id).to.be.eql(jobs[1].id);
    });
  });

  it('should allow removing a named repeatable job', async function () {
    const numJobs = 3;
    const date = new Date('2017-02-07 9:24:00');
    let prev: Job;
    let counter = 0;

    this.clock.setSystemTime(date);

    const nextTick = ONE_SECOND + 1;
    const repeat = { pattern: '*/1 * * * * *' };
    let processor;

    const processing = new Promise<void>((resolve, reject) => {
      processor = async () => {
        counter++;
        if (counter == numJobs) {
          const removed = await queue.removeRepeatable('remove', repeat);
          expect(removed).to.be.true;
          this.clock.tick(nextTick);
          const delayed = await queue.getDelayed();
          expect(delayed).to.be.empty;
          resolve();
        } else if (counter > numJobs) {
          reject(Error(`should not repeat more than ${numJobs} times`));
        }
      };
    });

    const worker = new Worker(queueName, processor, { connection });
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

    await queue.add('remove', { foo: 'bar' }, { repeat });
    this.clock.tick(nextTick);

    worker.on('completed', job => {
      this.clock.tick(nextTick);
      if (prev) {
        expect(prev.timestamp).to.be.lt(job.timestamp);
        expect(job.timestamp - prev.timestamp).to.be.gte(ONE_SECOND);
      }
      prev = job;
    });

    await processing;
    await worker.close();
    delayStub.restore();
  });

  it('should be able to remove repeatable jobs by key', async () => {
    const repeat = { pattern: '*/2 * * * * *' };

    const createdJob = await queue.add('remove', { foo: 'bar' }, { repeat });
    const job = await queue.getJob(createdJob.id);
    const repeatableJobs = await queue.getRepeatableJobs();
    expect(repeatableJobs).to.have.length(1);
    const removed = await queue.removeRepeatableByKey(createdJob.repeatJobKey);
    expect(job.repeatJobKey).to.not.be.undefined;
    expect(removed).to.be.true;
    const repeatableJobsAfterRemove = await queue.getRepeatableJobs();
    expect(repeatableJobsAfterRemove).to.have.length(0);
  });

  describe('when repeatable job does not exist', function () {
    it('returns false', async () => {
      const repeat = { pattern: '*/2 * * * * *' };

      await queue.add('remove', { foo: 'bar' }, { repeat });
      const repeatableJobs = await queue.getRepeatableJobs();
      expect(repeatableJobs).to.have.length(1);
      const removed = await queue.removeRepeatableByKey(repeatableJobs[0].key);
      expect(removed).to.be.true;
      const removed2 = await queue.removeRepeatableByKey(repeatableJobs[0].key);
      expect(removed2).to.be.false;
    });
  });

  it('should allow removing a customId repeatable job', async function () {
    const numJobs = 4;
    const date = new Date('2017-02-07 9:24:00');
    let prev: Job;
    let counter = 0;
    let processor;
    const jobId = 'xxxx';

    this.clock.setSystemTime(date);

    const nextTick = 2 * ONE_SECOND + 10;
    const repeat = { pattern: '*/2 * * * * *' };

    await queue.add('test', { foo: 'bar' }, { repeat, jobId });

    this.clock.tick(nextTick);

    const processing = new Promise<void>((resolve, reject) => {
      processor = async () => {
        counter++;
        if (counter == numJobs) {
          try {
            await queue.removeRepeatable('test', repeat, jobId);
            this.clock.tick(nextTick);
            const delayed = await queue.getDelayed();
            expect(delayed).to.be.empty;
            resolve();
          } catch (err) {
            reject(err);
          }
        } else if (counter > numJobs) {
          reject(Error(`should not repeat more than ${numJobs} times`));
        }
      };
    });

    const worker = new Worker(queueName, processor, { connection });
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});
    await worker.waitUntilReady();

    worker.on('completed', job => {
      this.clock.tick(nextTick);
      if (prev) {
        expect(prev.timestamp).to.be.lt(job.timestamp);
        expect(job.timestamp - prev.timestamp).to.be.gte(2000);
      }
      prev = job;
    });

    await processing;
    delayStub.restore();
  });

  // This test is flaky and too complex we need something simpler that tests the same thing
  it.skip('should not re-add a repeatable job after it has been removed', async function () {
    const repeat = await queue.repeat;

    let worker: Worker;
    const jobId = 'xxxx';
    const date = new Date('2017-02-07 9:24:00');
    const nextTick = 2 * ONE_SECOND + 100;
    const addNextRepeatableJob = repeat.addNextRepeatableJob;
    this.clock.setSystemTime(date);

    const repeatOpts = { pattern: '*/2 * * * * *' };

    const afterRemoved = new Promise<void>(async resolve => {
      worker = new Worker(
        queueName,
        async () => {
          const repeatWorker = await worker.repeat;
          (<unknown>repeatWorker.addNextRepeatableJob) = async (
            ...args: [string, unknown, JobsOptions, boolean?]
          ) => {
            // In order to simulate race condition
            // Make removeRepeatables happen any time after a moveToX is called
            await queue.removeRepeatable('test', repeatOpts, jobId);

            // addNextRepeatableJob will now re-add the removed repeatable
            const result = await addNextRepeatableJob.apply(repeat, args);
            resolve();
            return result;
          };
        },
        { connection },
      );

      worker.on('completed', () => {
        this.clock.tick(nextTick);
      });
    });

    await queue.add('test', { foo: 'bar' }, { repeat: repeatOpts, jobId });

    this.clock.tick(nextTick);

    await afterRemoved;

    const jobs = await queue.getRepeatableJobs();
    // Repeatable job was recreated
    expect(jobs.length).to.eql(0);

    await worker.close();
  });

  it('should allow adding a repeatable job after removing it', async function () {
    const repeat = {
      pattern: '*/5 * * * *',
    };

    const worker = new Worker(queueName, NoopProc, { connection });
    await worker.waitUntilReady();
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

    await queue.add(
      'myTestJob',
      {
        data: '2',
      },
      {
        repeat: repeat,
      },
    );
    let delayed = await queue.getDelayed();
    expect(delayed.length).to.be.eql(1);

    await new Promise<void>(resolve => {
      queueEvents.on('removed', async ({ jobId, prev }) => {
        expect(jobId).to.be.equal(delayed[0].id);
        expect(prev).to.be.equal('delayed');
        resolve();
      });

      queue.removeRepeatable('myTestJob', repeat);
    });

    delayed = await queue.getDelayed();
    expect(delayed.length).to.be.eql(0);

    await queue.add('myTestJob', { data: '2' }, { repeat: repeat });

    delayed = await queue.getDelayed();
    expect(delayed.length).to.be.eql(1);

    await worker.close();
    delayStub.restore();
  });

  it('should not repeat more than 5 times', async function () {
    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);
    const nextTick = ONE_SECOND + 500;

    const worker = new Worker(queueName, NoopProc, { connection });
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

    await queue.add(
      'repeat',
      { foo: 'bar' },
      { repeat: { limit: 5, pattern: '*/1 * * * * *' } },
    );
    this.clock.tick(nextTick);

    let counter = 0;

    const completing = new Promise<void>((resolve, reject) => {
      worker.on('completed', () => {
        this.clock.tick(nextTick);
        counter++;
        if (counter == 5) {
          resolve();
        } else if (counter > 5) {
          reject(Error('should not repeat more than 5 times'));
        }
      });
    });

    await completing;
    await worker.close();
    delayStub.restore();
  });

  it('should processes delayed jobs by priority', async function () {
    let currentPriority = 1;
    const nextTick = 1000;

    let processor;

    const processing = new Promise<void>((resolve, reject) => {
      processor = async (job: Job) => {
        try {
          expect(job.id).to.be.ok;
          expect(job.data.p).to.be.eql(currentPriority++);
        } catch (err) {
          reject(err);
        }

        if (currentPriority > 3) {
          resolve();
        }
      };
    });

    await Promise.all([
      queue.add('test', { p: 1 }, { priority: 1, delay: nextTick * 3 }),
      queue.add('test', { p: 2 }, { priority: 2, delay: nextTick * 2 }),
      queue.add('test', { p: 3 }, { priority: 3, delay: nextTick }),
    ]);

    this.clock.tick(nextTick * 3 + 100);

    const worker = new Worker(queueName, processor, { connection });
    await worker.waitUntilReady();

    await processing;

    await worker.close();
  });

  it('should use ".every" as a valid interval', async function () {
    const interval = ONE_SECOND * 2;
    const date = new Date('2017-02-07 9:24:00');

    this.clock.setSystemTime(date);

    const nextTick = ONE_SECOND * 2 + 500;

    await queue.add('repeat m', { type: 'm' }, { repeat: { every: interval } });
    await queue.add('repeat s', { type: 's' }, { repeat: { every: interval } });
    this.clock.tick(nextTick);

    const worker = new Worker(queueName, async () => {}, { connection });
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});
    await worker.waitUntilReady();

    let prevType: string;
    let counter = 0;

    const completing = new Promise<void>(resolve => {
      worker.on('completed', job => {
        this.clock.tick(nextTick);
        if (prevType) {
          expect(prevType).to.not.be.eql(job.data.type);
        }
        prevType = job.data.type;
        counter++;
        if (counter == 20) {
          resolve();
        }
      });
    });

    await completing;
    await worker.close();
    delayStub.restore();
  });

  it('should throw an error when using .pattern and .every simultaneously', async function () {
    await expect(
      queue.add(
        'repeat',
        { type: 'm' },
        { repeat: { every: 5000, pattern: '* /1 * * * * *' } },
      ),
    ).to.be.rejectedWith(
      'Both .pattern and .every options are defined for this repeatable job',
    );
  });

  it('should emit a waiting event when adding a repeatable job to the waiting list', async function () {
    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);
    const nextTick = 1 * ONE_SECOND + 500;

    const worker = new Worker(queueName, async job => {}, { connection });
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

    const waiting = new Promise<void>((resolve, reject) => {
      queueEvents.on('waiting', function ({ jobId }) {
        try {
          expect(jobId).to.be.equal(
            `repeat:c602b9b36e4beddd9e7db39a3ef2ea4c:${
              date.getTime() + 1 * ONE_SECOND
            }`,
          );
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });

    await queue.add(
      'test',
      { foo: 'bar' },
      { repeat: { pattern: '*/1 * * * * *' } },
    );
    this.clock.tick(nextTick);

    await waiting;
    await worker.close();
    delayStub.restore();
  });

  it('should have the right count value', async function () {
    await queue.add('test', { foo: 'bar' }, { repeat: { every: 1000 } });
    this.clock.tick(ONE_SECOND + 100);

    let processor;
    const processing = new Promise<void>((resolve, reject) => {
      processor = async (job: Job) => {
        if (job.opts.repeat.count === 1) {
          resolve();
        } else {
          reject(new Error('repeatable job got the wrong repeat count'));
        }
      };
    });

    const worker = new Worker(queueName, processor, { connection });

    await processing;
    await worker.close();
  });
});
