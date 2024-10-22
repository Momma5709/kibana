/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { LogMeta, Logger } from '@kbn/core/server';
import type { ITelemetryEventsSender } from '../sender';
import type { ITelemetryReceiver } from '../receiver';
import type { TaskExecutionPeriod } from '../task';
import type { ITaskMetricsService } from '../task_metrics.types';
import {
  createUsageCounterLabel,
  getPreviousDailyTaskTimestamp,
  newTelemetryLogger,
} from '../helpers';
import {
  TELEMETRY_CLUSTER_STATS_EVENT,
  TELEMETRY_DATA_STREAM_EVENT,
  TELEMETRY_ILM_POLICY_EVENT,
  TELEMETRY_ILM_STATS_EVENT,
  TELEMETRY_INDEX_STATS_EVENT,
} from '../event_based/events';
import type { CommonPrefixesConfig } from '../collections_helpers';
import { telemetryConfiguration } from '../configuration';
import type { ClusterStats, DataStream } from '../indices.metadata.types';
import { TelemetryCounter } from '../types';

const COUNTER_LABELS = ['security_solution', 'indices-metadata'];

export function createTelemetryIndicesMetadataTaskConfig() {
  const taskType = 'security:indices-metadata-telemetry';
  return {
    type: taskType,
    title: 'Security Solution Telemetry Indices Metadata task',
    interval: '24h',
    timeout: '1m',
    version: '1.0.0',
    getLastExecutionTime: getPreviousDailyTaskTimestamp,
    runTask: async (
      taskId: string,
      logger: Logger,
      receiver: ITelemetryReceiver,
      sender: ITelemetryEventsSender,
      taskMetricsService: ITaskMetricsService,
      taskExecutionPeriod: TaskExecutionPeriod
    ) => {
      const mdc = { task_id: taskId, task_execution_period: taskExecutionPeriod };
      const log = newTelemetryLogger(logger.get('indices-metadata'), mdc);
      const trace = taskMetricsService.start(taskType);

      const taskConfig = telemetryConfiguration.indices_metadata_config;

      // TODO: not use taskExecutionPeriod, it's just to test the task using the temporary API
      const queryConfig: CommonPrefixesConfig = {
        maxPrefixes: Number(taskExecutionPeriod.last ?? taskConfig.max_prefixes),
        maxGroupSize: Number(taskExecutionPeriod.current ?? taskConfig.max_group_size),
        minGroupSize: Number(taskExecutionPeriod.current ?? taskConfig.min_group_size),
      };

      const publishClusterStats = (stats: ClusterStats) => {
        sender.reportEBT(TELEMETRY_CLUSTER_STATS_EVENT.eventType, stats);
      };

      const publishDatastreamsStats = (stats: DataStream[]): number => {
        let counter = 0;
        for (const ds of stats) {
          sender.reportEBT(TELEMETRY_DATA_STREAM_EVENT.eventType, ds);
          counter++;
        }
        log.info(`Sent data streams`, { count: counter } as LogMeta);
        return counter;
      };

      const publishIndicesStats = async (indices: string[]): Promise<number> => {
        let counter = 0;
        for await (const stat of receiver.getIndicesStats(
          indices.slice(0, taskConfig.indices_threshold),
          queryConfig
        )) {
          sender.reportEBT(TELEMETRY_INDEX_STATS_EVENT.eventType, stat);
          counter++;
        }
        log.info(`Sent indices stats`, { count: counter } as LogMeta);
        return counter;
      };

      const publishIlmStats = async (indices: string[]): Promise<Set<string>> => {
        const ilmNames = new Set<string>();
        for await (const stat of receiver.getIlmsStats(indices, queryConfig)) {
          if (stat.policy_name !== undefined) {
            ilmNames.add(stat.policy_name);
            sender.reportEBT(TELEMETRY_ILM_STATS_EVENT.eventType, stat);
          }
        }
        log.info(`Sent ILM stats`, { count: ilmNames.size } as LogMeta);

        return ilmNames;
      };

      const publishIlmPolicies = async (ilmNames: Set<string>): Promise<number> => {
        let counter = 0;
        for await (const policy of receiver.getIlmsPolicies(
          Array.from(ilmNames.values()),
          queryConfig
        )) {
          sender.reportEBT(TELEMETRY_ILM_POLICY_EVENT.eventType, policy);
          counter++;
        }
        log.info(`Sent ILM policies`, { count: counter } as LogMeta);
        return counter;
      };

      const incrementCounter = (type: TelemetryCounter, name: string, value: number) => {
        const telemetryUsageCounter = sender.getTelemetryUsageCluster();
        telemetryUsageCounter?.incrementCounter({
          counterName: createUsageCounterLabel(COUNTER_LABELS.concat(name)),
          counterType: type,
          incrementBy: value,
        });
      };

      try {
        // 1. Get cluster stats and list of indices and datastreams
        const [clusterStats, indices, dataStreams] = await Promise.all([
          receiver.getClusterStats(),
          receiver.getIndices(),
          receiver.getDataStreams(),
        ]);

        // 2. Publish cluster stats
        publishClusterStats(clusterStats);
        incrementCounter(TelemetryCounter.DOCS_SENT, 'cluster-stats', 1);

        // 3. Publish datastreams stats
        const dsCount = publishDatastreamsStats(
          dataStreams.slice(0, taskConfig.datastreams_threshold)
        );
        incrementCounter(TelemetryCounter.DOCS_SENT, 'datastreams-stats', dsCount);

        // 4. Get and publish indices stats
        const indicesCount: number = await publishIndicesStats(
          indices.slice(0, taskConfig.indices_threshold)
        )
          .then((count) => {
            incrementCounter(TelemetryCounter.DOCS_SENT, 'indices-stats', count);
            return count;
          })
          .catch((err) => {
            log.warn(`Error getting indices stats`, { error: err.message } as LogMeta);
            incrementCounter(TelemetryCounter.RUNTIME_ERROR, 'indices-stats', 1);
            return 0;
          });

        // 5. Get ILM stats and publish them
        const ilmNames = await publishIlmStats(indices.slice(0, taskConfig.indices_threshold))
          .then((names) => {
            incrementCounter(TelemetryCounter.DOCS_SENT, 'ilm-stats', names.size);
            return names;
          })
          .catch((err) => {
            log.warn(`Error getting ILM stats`, { error: err.message } as LogMeta);
            incrementCounter(TelemetryCounter.RUNTIME_ERROR, 'ilm-stats', 1);
            return new Set<string>();
          });

        // 6. Publish ILM policies
        const policyCount = await publishIlmPolicies(ilmNames)
          .then((count) => {
            incrementCounter(TelemetryCounter.DOCS_SENT, 'ilm-policies', count);
            return count;
          })
          .catch((err) => {
            log.warn(`Error getting ILM policies`, { error: err.message } as LogMeta);
            incrementCounter(TelemetryCounter.RUNTIME_ERROR, 'ilm-policies', 1);
            return 0;
          });

        log.info(`Sent EBT events`, {
          datastreams: dsCount,
          ilms: ilmNames.size,
          indices: indicesCount,
          policies: policyCount,
        } as LogMeta);

        await taskMetricsService.end(trace);

        return indicesCount;
      } catch (err) {
        log.warn(`Error running indices metadata task`, {
          error: err.message,
        } as LogMeta);
        await taskMetricsService.end(trace, err);
        return 0;
      }
    },
  };
}
