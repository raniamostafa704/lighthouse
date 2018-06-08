/**
 * @license Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const Node = require('../node');
const NetworkNode = require('../network-node'); // eslint-disable-line no-unused-vars
const CpuNode = require('../cpu-node'); // eslint-disable-line no-unused-vars
const TcpConnection = require('./tcp-connection');
const ConnectionPool = require('./connection-pool');
const mobile3G = require('../../../config/constants').throttling.mobile3G;

// see https://cs.chromium.org/search/?q=kDefaultMaxNumDelayableRequestsPerClient&sq=package:chromium&type=cs
const DEFAULT_MAXIMUM_CONCURRENT_REQUESTS = 10;
// layout tasks tend to be less CPU-bound and do not experience the same increase in duration
const DEFAULT_LAYOUT_TASK_MULTIPLIER = 0.5;
// if a task takes more than 10 seconds it's usually a sign it isn't actually CPU bound and we're overestimating
const DEFAULT_MAXIMUM_CPU_TASK_DURATION = 10000;

const NodeState = {
  NotReadyToStart: 0,
  ReadyToStart: 1,
  InProgress: 2,
  Complete: 3,
};

class Simulator {
  /**
   * @param {LH.Gatherer.Simulation.Options} [options]
   */
  constructor(options) {
    /** @type {Required<LH.Gatherer.Simulation.Options>} */
    this._options = Object.assign(
      {
        rtt: mobile3G.rttMs,
        throughput: mobile3G.throughputKbps * 1024,
        maximumConcurrentRequests: DEFAULT_MAXIMUM_CONCURRENT_REQUESTS,
        cpuSlowdownMultiplier: mobile3G.cpuSlowdownMultiplier,
        layoutTaskMultiplier: DEFAULT_LAYOUT_TASK_MULTIPLIER,
        additionalRttByOrigin: new Map(),
        serverResponseTimeByOrigin: new Map(),
      },
      options
    );

    this._rtt = this._options.rtt;
    this._throughput = this._options.throughput;
    this._maximumConcurrentRequests = Math.max(Math.min(
      TcpConnection.maximumSaturatedConnections(this._rtt, this._throughput),
      this._options.maximumConcurrentRequests
    ), 1);
    this._cpuSlowdownMultiplier = this._options.cpuSlowdownMultiplier;
    this._layoutTaskMultiplier = this._cpuSlowdownMultiplier * this._options.layoutTaskMultiplier;

    // Properties reset on every `.simulate` call but duplicated here for type checking
    this._flexibleOrdering = false;
    /** @type {Map<Node, NodeTimingIntermediate>} */
    this._nodeTimings = new Map();
    /** @type {Map<string, number>} */
    this._numberInProgressByType = new Map();
    this._nodes = {};
    // @ts-ignore
    this._connectionPool = /** @type {ConnectionPool} */ (null);
  }

  /**
   * @param {Node} graph
   */
  _initializeConnectionPool(graph) {
    /** @type {LH.WebInspector.NetworkRequest[]} */
    const records = [];
    graph.getRootNode().traverse(node => {
      if (node.type === Node.TYPES.NETWORK) {
        records.push(/** @type {NetworkNode} */ (node).record);
      }
    });

    this._connectionPool = new ConnectionPool(records, this._options);
  }

  /**
   * Initializes the various state data structures such as _nodesReadyToStart and _nodesCompleted.
   */
  _initializeAuxiliaryData() {
    this._nodeTimings = new Map();
    this._numberInProgressByType = new Map();

    this._nodes = {};
    for (const key of Object.keys(NodeState)) {
      this._nodes[NodeState[key]] = new Set();
    }
  }

  /**
   * @param {string} type
   * @return {number}
   */
  _numberInProgress(type) {
    return this._numberInProgressByType.get(type) || 0;
  }

  /**
   * @param {Node} node
   * @param {NodeTimingIntermediate} values
   */
  _setTimingData(node, values) {
    const timingData = this._nodeTimings.get(node) || {};
    Object.assign(timingData, values);
    this._nodeTimings.set(node, timingData);
  }

  /**
   * @param {Node} node
   * @return {NodeTimingIntermediate}
   */
  _getTimingData(node) {
    const timingData = this._nodeTimings.get(node);
    if (!timingData) throw new Error(`Unable to get timing data for node ${node.id}`);
    return timingData;
  }

  /**
   * @param {Node} node
   * @param {number} queuedTime
   */
  _markNodeAsReadyToStart(node, queuedTime) {
    this._nodes[NodeState.ReadyToStart].add(node);
    this._nodes[NodeState.NotReadyToStart].delete(node);
    this._setTimingData(node, {queuedTime});
  }

  /**
   * @param {Node} node
   * @param {number} startTime
   */
  _markNodeAsInProgress(node, startTime) {
    this._nodes[NodeState.InProgress].add(node);
    this._nodes[NodeState.ReadyToStart].delete(node);
    this._numberInProgressByType.set(node.type, this._numberInProgress(node.type) + 1);
    this._setTimingData(node, {startTime});
  }

  /**
   * @param {Node} node
   * @param {number} endTime
   */
  _markNodeAsComplete(node, endTime) {
    this._nodes[NodeState.Complete].add(node);
    this._nodes[NodeState.InProgress].delete(node);
    this._numberInProgressByType.set(node.type, this._numberInProgress(node.type) - 1);
    this._setTimingData(node, {endTime});

    // Try to add all its dependents to the queue
    for (const dependent of node.getDependents()) {
      // Skip dependent node if one of its dependencies hasn't finished yet
      const dependencies = dependent.getDependencies();
      if (dependencies.some(dep => !this._nodes[NodeState.Complete].has(dep))) continue;

      // Otherwise add it to the queue
      this._markNodeAsReadyToStart(dependent, endTime);
    }
  }

  /**
   * @param {LH.WebInspector.NetworkRequest} record
   * @return {?TcpConnection}
   */
  _acquireConnection(record) {
    return this._connectionPool.acquire(record, {
      ignoreConnectionReused: this._flexibleOrdering,
    });
  }

  /**
   * @param {Node} node
   * @param {number} totalElapsedTime
   */
  _startNodeIfPossible(node, totalElapsedTime) {
    if (node.type === Node.TYPES.CPU) {
      // Start a CPU task if there's no other CPU task in process
      if (this._numberInProgress(node.type) === 0) {
        this._markNodeAsInProgress(node, totalElapsedTime);
        this._setTimingData(node, {timeElapsed: 0});
      }

      return;
    }

    if (node.type !== Node.TYPES.NETWORK) throw new Error('Unsupported');

    const networkNode = /** @type {NetworkNode} */ (node);
    // If a network request is cached, we can always start it, so skip the connection checks
    if (!networkNode.fromDiskCache) {
      // Start a network request if we're not at max requests and a connection is available
      const numberOfActiveRequests = this._numberInProgress(node.type);
      if (numberOfActiveRequests >= this._maximumConcurrentRequests) return;
      const connection = this._acquireConnection(networkNode.record);
      if (!connection) return;
    }

    this._markNodeAsInProgress(node, totalElapsedTime);
    this._setTimingData(node, {
      timeElapsed: 0,
      timeElapsedOvershoot: 0,
      bytesDownloaded: 0,
    });
  }

  /**
   * Updates each connection in use with the available throughput based on the number of network requests
   * currently in flight.
   */
  _updateNetworkCapacity() {
    for (const connection of this._connectionPool.connectionsInUse()) {
      connection.setThroughput(this._throughput / this._nodes[NodeState.InProgress].size);
    }
  }

  /**
   * Estimates the number of milliseconds remaining given current condidtions before the node is complete.
   * @param {Node} node
   * @return {number}
   */
  _estimateTimeRemaining(node) {
    if (node.type === Node.TYPES.CPU) {
      return this._estimateCPUTimeRemaining(/** @type {CpuNode} */ (node));
    } else if (node.type === Node.TYPES.NETWORK) {
      return this._estimateNetworkTimeRemaining(/** @type {NetworkNode} */ (node));
    } else {
      throw new Error('Unsupported');
    }
  }

  /**
   * @param {CpuNode} cpuNode
   * @return {number}
   */
  _estimateCPUTimeRemaining(cpuNode) {
    const timingData = this._getTimingData(cpuNode);
    const multiplier = cpuNode.didPerformLayout()
      ? this._layoutTaskMultiplier
      : this._cpuSlowdownMultiplier;
    const totalDuration = Math.min(
      Math.round(cpuNode.event.dur / 1000 * multiplier),
      DEFAULT_MAXIMUM_CPU_TASK_DURATION
    );
    const estimatedTimeElapsed = totalDuration - timingData.timeElapsed;
    this._setTimingData(cpuNode, {estimatedTimeElapsed});
    return estimatedTimeElapsed;
  }

  /**
   * @param {NetworkNode} networkNode
   * @return {number}
   */
  _estimateNetworkTimeRemaining(networkNode) {
    const timingData = this._getTimingData(networkNode);

    let timeElapsed = 0;
    if (networkNode.fromDiskCache) {
      // Rough access time for seeking to location on disk and reading sequentially
      // @see http://norvig.com/21-days.html#answers
      const sizeInMb = (networkNode.record._resourceSize || 0) / 1024 / 1024;
      timeElapsed = 8 + 20 * sizeInMb - timingData.timeElapsed;
    } else {
      // If we're estimating time remaining, we already acquired a connection for this record, definitely non-null
      const connection = /** @type {TcpConnection} */ (this._acquireConnection(networkNode.record));
      const calculation = connection.simulateDownloadUntil(
        networkNode.record.transferSize - timingData.bytesDownloaded,
        {timeAlreadyElapsed: timingData.timeElapsed, maximumTimeToElapse: Infinity}
      );

      timeElapsed = calculation.timeElapsed;
    }

    const estimatedTimeElapsed = timeElapsed + timingData.timeElapsedOvershoot;
    this._setTimingData(networkNode, {estimatedTimeElapsed});
    return estimatedTimeElapsed;
  }

  /**
   * Computes and returns the minimum estimated completion time of the nodes currently in progress.
   * @return {number}
   */
  _findNextNodeCompletionTime() {
    let minimumTime = Infinity;
    for (const node of this._nodes[NodeState.InProgress]) {
      minimumTime = Math.min(minimumTime, this._estimateTimeRemaining(node));
    }

    return minimumTime;
  }

  /**
   * Given a time period, computes the progress toward completion that the node made durin that time.
   * @param {Node} node
   * @param {number} timePeriodLength
   * @param {number} totalElapsedTime
   */
  _updateProgressMadeInTimePeriod(node, timePeriodLength, totalElapsedTime) {
    const timingData = this._getTimingData(node);
    const isFinished = timingData.estimatedTimeElapsed === timePeriodLength;

    const networkNode = /** @type {NetworkNode} */ (node);

    if (node.type === Node.TYPES.CPU || networkNode.fromDiskCache) {
      return isFinished
        ? this._markNodeAsComplete(node, totalElapsedTime)
        : (timingData.timeElapsed += timePeriodLength);
    }

    if (node.type !== Node.TYPES.NETWORK) throw new Error('Unsupported');

    const record = networkNode.record;
    // If we're updating the progress, we already acquired a connection for this record, definitely non-null
    const connection = /** @type {TcpConnection} */ (this._acquireConnection(record));
    const calculation = connection.simulateDownloadUntil(
      record.transferSize - timingData.bytesDownloaded,
      {
        timeAlreadyElapsed: timingData.timeElapsed,
        maximumTimeToElapse: timePeriodLength - timingData.timeElapsedOvershoot,
      }
    );

    connection.setCongestionWindow(calculation.congestionWindow);
    connection.setH2OverflowBytesDownloaded(calculation.extraBytesDownloaded);

    if (isFinished) {
      connection.setWarmed(true);
      this._connectionPool.release(record);
      this._markNodeAsComplete(node, totalElapsedTime);
    } else {
      timingData.timeElapsed += calculation.timeElapsed;
      timingData.timeElapsedOvershoot += calculation.timeElapsed - timePeriodLength;
      timingData.bytesDownloaded += calculation.bytesDownloaded;
    }
  }

  _computeFinalNodeTimings() {
    /** @type {Map<Node, LH.Gatherer.Simulation.NodeTiming>} */
    const nodeTimings = new Map();
    for (const [node, timing] of this._nodeTimings) {
      nodeTimings.set(node, {
        startTime: timing.startTime,
        endTime: timing.endTime,
        duration: timing.endTime - timing.startTime,
      });
    }

    return nodeTimings;
  }

  /**
   * @return {Required<LH.Gatherer.Simulation.Options>}
   */
  getOptions() {
    return this._options;
  }

  /**
   * Estimates the time taken to process all of the graph's nodes, returns the overall time along with
   * each node annotated by start/end times.
   *
   * If flexibleOrdering is set, simulator/connection pool are allowed to deviate from what was
   * observed in the trace/devtoolsLog and start requests as soon as they are queued (i.e. do not
   * wait around for a warm connection to be available if the original record was fetched on a warm
   * connection).
   *
   * @param {Node} graph
   * @param {{flexibleOrdering?: boolean}=} options
   * @return {LH.Gatherer.Simulation.Result}
   */
  simulate(graph, options) {
    if (Node.hasCycle(graph)) {
      throw new Error('Cannot simulate graph with cycle');
    }

    options = Object.assign({flexibleOrdering: false}, options);
    // initialize the necessary data containers
    this._flexibleOrdering = !!options.flexibleOrdering;
    this._initializeConnectionPool(graph);
    this._initializeAuxiliaryData();

    const nodesNotReadyToStart = this._nodes[NodeState.NotReadyToStart];
    const nodesReadyToStart = this._nodes[NodeState.ReadyToStart];
    const nodesInProgress = this._nodes[NodeState.InProgress];

    const rootNode = graph.getRootNode();
    rootNode.traverse(node => nodesNotReadyToStart.add(node));
    let totalElapsedTime = 0;
    let iteration = 0;

    // root node is always ready to start
    this._markNodeAsReadyToStart(rootNode, totalElapsedTime);

    // loop as long as we have nodes in the queue or currently in progress
    while (nodesReadyToStart.size || nodesInProgress.size) {
      // move all possible queued nodes to in progress
      for (const node of nodesReadyToStart) {
        this._startNodeIfPossible(node, totalElapsedTime);
      }

      if (!nodesInProgress.size) {
        // interplay between fromDiskCache and connectionReused can be incorrect
        // proceed with flexibleOrdering if we can, otherwise give up
        if (this._flexibleOrdering) throw new Error('Failed to start a node');
        this._flexibleOrdering = true;
        continue;
      }

      // set the available throughput for all connections based on # inflight
      this._updateNetworkCapacity();

      // find the time that the next node will finish
      const minimumTime = this._findNextNodeCompletionTime();
      totalElapsedTime += minimumTime;

      // While this is no longer strictly necessary, it's always better than LH hanging
      if (!Number.isFinite(minimumTime) || iteration > 100000) {
        throw new Error('Graph creation failed, depth exceeded');
      }

      iteration++;
      // update how far each node will progress until that point
      for (const node of nodesInProgress) {
        this._updateProgressMadeInTimePeriod(node, minimumTime, totalElapsedTime);
      }
    }

    global.simCount = global.simCount || 0;
    global.simCount++;
    if (global.simCount === 2) {
      for (const [node, timing] of this._computeFinalNodeTimings()) {
        console.log(node.record.url, node.record.priority(), node.record._resourceType._name, timing.endTime)
      }
    }

    return {
      timeInMs: totalElapsedTime,
      nodeTimings: this._computeFinalNodeTimings(),
    };
  }
}

module.exports = Simulator;

/**
 * @typedef NodeTimingIntermediate
 * @property {number} [startTime]
 * @property {number} [endTime]
 * @property {number} [queuedTime]
 * @property {number} [estimatedTimeElapsed]
 * @property {number} [timeElapsed]
 * @property {number} [timeElapsedOvershoot]
 * @property {number} [bytesDownloaded]
 */
