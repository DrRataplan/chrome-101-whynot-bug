function addInstruction(program, op, func, data) {
    const instruction = { op, func, data };
    program.push(instruction);
    return instruction;
}
function defaultRecorder(data, _inputIndex) {
    return data;
}
/**
 * The Assembler is used to generate a whynot program by appending instructions.
 *
 * @public
 */
class Assembler {
    constructor() {
        this.program = [];
    }
    /**
     * The 'test' instruction validates and consumes an input item.
     *
     * If the matcher returns true, execution continues in the next Generation, otherwise execution
     * of the current Thread ends.
     *
     * @param matcher - Callback to invoke for the input, should return true to accept, false to
     *                  reject.
     * @param data    - Data to be passed to the matcher callback. Defaults to null.
     *
     * @returns The new instruction
     */
    test(matcher, data) {
        return addInstruction(this.program, 5 /* TEST */, matcher, data === undefined ? null : data);
    }
    /**
     * The 'jump' instruction continues execution in the current Generation at any number of other
     * locations. A new Thread will be spawned for each target.
     *
     * @param targets - Program counters at which to continue execution
     *
     * @returns The new instruction
     */
    jump(targets) {
        return addInstruction(this.program, 3 /* JUMP */, null, targets);
    }
    /**
     * The 'record' instruction adds a custom record to the current Thread's trace and resumes
     * execution at the next instruction in the same Generation.
     *
     * @param data     - Data to record
     * @param recorder - Callback to generate the record based on data and the current input
     *                   position. Defaults to recording data.
     *
     * @returns The new instruction
     */
    record(data, recorder) {
        return addInstruction(this.program, 4 /* RECORD */, recorder === undefined ? defaultRecorder : recorder, data);
    }
    /**
     * The 'bad' instruction permanently lowers the priority of all threads originating in the
     * current one.
     *
     * @param cost - Amount to increase badness with. Defaults to 1.
     *
     * @returns The new instruction
     */
    bad(cost = 1) {
        return addInstruction(this.program, 1 /* BAD */, null, cost);
    }
    /**
     * The 'accept' instruction causes the VM to yield the current Thread's Trace upon completion,
     * provided all input has been consumed. Otherwise, the Thread ends.
     *
     * @returns The new instruction
     */
    accept() {
        return addInstruction(this.program, 0 /* ACCEPT */, null, null);
    }
    /**
     * The 'fail' instruction ends the current Thread.
     *
     * @param predicate - Optional callback to make the fail conditional, if this returns true the
     *                    thread will end, otherwise it will continue.
     *
     * @returns The new instruction
     */
    fail(predicate) {
        return addInstruction(this.program, 2 /* FAIL */, predicate || null, null);
    }
}

/**
 * Computes information about a given program, used to allocate enough space in the data structures
 * required to run that program.
 */
class ProgramInfo {
    constructor(programLength, maxFromByPc, maxSurvivorFromByPc) {
        this.programLength = programLength;
        this.maxFromByPc = maxFromByPc;
        this.maxSurvivorFromByPc = maxSurvivorFromByPc;
    }
    /**
     * Creates an instance with information for the given program.
     *
     * @param program - The program for which to construct the instance.
     */
    static fromProgram(program) {
        const programLength = program.length;
        // Determine maximum number of incoming paths per instructon
        const maxFromByPc = [];
        const maxSurvivorFromByPc = [];
        program.forEach(_ => {
            maxFromByPc.push(0);
            maxSurvivorFromByPc.push(0);
        });
        program.forEach((instruction, pc) => {
            switch (instruction.op) {
                case 2 /* FAIL */:
                    if (instruction.func === null) {
                        // Unconditional fail, threads will never continue past this instruction
                        return;
                    }
                    if (pc + 1 >= programLength) {
                        throw new Error('Invalid program: program could run past end');
                    }
                    maxFromByPc[pc + 1] += 1;
                    break;
                case 1 /* BAD */:
                case 4 /* RECORD */:
                    if (pc + 1 >= programLength) {
                        throw new Error('Invalid program: program could run past end');
                    }
                    maxFromByPc[pc + 1] += 1;
                    break;
                case 3 /* JUMP */:
                    const targets = instruction.data;
                    targets.forEach(targetPc => {
                        if (targetPc < 0 || targetPc >= programLength) {
                            throw new Error('Invalid program: program could run past end');
                        }
                        maxFromByPc[targetPc] += 1;
                    });
                    break;
                case 5 /* TEST */:
                    if (pc + 1 >= programLength) {
                        throw new Error('Invalid program: program could run past end');
                    }
                    maxSurvivorFromByPc[pc + 1] += 1;
                    break;
                case 0 /* ACCEPT */:
                    maxSurvivorFromByPc[pc] += 1;
                    break;
            }
        });
        return new ProgramInfo(programLength, maxFromByPc, maxSurvivorFromByPc);
    }
    /**
     * Creates a stub ProgramInfo with incoming info maxed out to ensure enough space is allocated
     * in FromBuffers for simulating any program of the given length.
     *
     * For testing only.
     *
     * @param programLength The length of the supposed program
     */
    static createStub(programLength) {
        const maxFromByPc = [];
        const maxSurvivorFromByPc = [];
        for (let i = 0; i < programLength; ++i) {
            maxFromByPc.push(programLength);
            maxSurvivorFromByPc.push(programLength);
        }
        return new ProgramInfo(programLength, maxFromByPc, maxSurvivorFromByPc);
    }
}

/**
 * The result of running a VM on an input sequence.
 *
 * @public
 */
class Result {
    constructor(
    /**
     * The traces that lead to input being accepted, or an empty array if the input was not
     * accepted by the program.
     */
    acceptingTraces) {
        this.acceptingTraces = acceptingTraces;
        this.success = acceptingTraces.length > 0;
    }
}

/**
 * Perform a binary search to find the index of the first thread with lower badness, within the
 * given bounds.
 *
 * This can then be the index at which to insert a new pc while preserving ordering according to
 * badness.
 *
 * @param pcs         - The array of scheduled pcs to search.
 * @param badnessByPc - Provides the current badness value for each pc in the array.
 * @param badness     - The badness to compare to (i.e., the value for the pc to be inserted).
 * @param first       - First index in pcs to consider.
 * @param length      - The length of the sub-array of pcs to consider. Also the highest index that
 *                      can be returned by this function.
 */
function findInsertionIndex(pcs, badnessByPc, badness, first, length) {
    let low = first;
    let high = length;
    while (low < high) {
        // Use zero-filling shift as integer division
        const mid = (low + high) >>> 1;
        // Compare to mid point, preferring right in case of equality
        if (badness < badnessByPc[pcs[mid]]) {
            // Thread goes in lower half
            high = mid;
        }
        else {
            // Thread goes in upper half
            low = mid + 1;
        }
    }
    return low;
}
/**
 * The highest supported badness value. Attempts to set badness higher than this are clamped to this
 * value.
 */
const MAX_BADNESS = 255;
/**
 * Schedules threads within a Generation according to their associated badness.
 */
class Generation {
    constructor(programLength) {
        this._numScheduledPcs = 0;
        // Index of the next thread to execute in the array above
        this._nextThread = 0;
        this._scheduledPcs = new Uint16Array(programLength);
        this._badnessByPc = new Uint8Array(programLength);
    }
    getBadness(pc) {
        return this._badnessByPc[pc];
    }
    /**
     * Adds a new entry for pc to the scheduled pcs.
     *
     * The caller should ensure that pc is not already scheduled.
     *
     * @param pc      The pc to add
     * @param badness The badness to associate with pc
     */
    add(pc, badness) {
       this._badnessByPc[pc] = badness > MAX_BADNESS ? MAX_BADNESS : badness;
        const insertionIndex = findInsertionIndex(this._scheduledPcs, this._badnessByPc, badness, this._nextThread, this._numScheduledPcs);
        this._scheduledPcs.copyWithin(insertionIndex + 1, insertionIndex, this._numScheduledPcs);
        this._scheduledPcs[insertionIndex] = pc;
        this._numScheduledPcs += 1;
    }
    /**
     * Reschedule an already scheduled pc according to a new badness value.
     *
     * The caller should ensure this is only called for pcs that have already been scheduled.
     *
     * @param pc      The pc to reschedule
     * @param badness The new badness to associate with pc
     */
    reschedule(pc, badness) {
        const maxBadness = Math.max(this._badnessByPc[pc], badness > MAX_BADNESS ? MAX_BADNESS : badness);
        if (this._badnessByPc[pc] !== maxBadness) {
            // Remove any existing unexecuted thread in order to reschedule it
            const existingThreadIndex = this._scheduledPcs.indexOf(pc, this._nextThread);
            if (existingThreadIndex < 0 || existingThreadIndex >= this._numScheduledPcs) {
                this._badnessByPc[pc] = maxBadness;
                // Thread has already been executed, do not reschedule
                return;
            }
            // Remove and re-schedule the thread
            // TODO: use a single copyWithin call instead of two
            this._scheduledPcs.copyWithin(existingThreadIndex, existingThreadIndex + 1, this._numScheduledPcs);
            this._numScheduledPcs -= 1;
            this.add(pc, maxBadness);
        }
    }
    /**
     * Get the next scheduled pc.
     *
     * This pc will have the lowest badness among all currently scheduled pcs.
     *
     * Returns null if there are no more scheduled pcs in this Generation.
     */
    getNextPc() {
        if (this._nextThread >= this._numScheduledPcs) {
            return null;
        }
        const pc = this._scheduledPcs[this._nextThread];
		this._nextThread = this._nextThread + 1;
		return pc;
    }
    /**
     * Clear all scheduled pcs and badness values so the Generation can be reused.
     */
    reset() {
        this._numScheduledPcs = 0;
        this._nextThread = 0;
        this._badnessByPc.fill(0);
    }
}

/**
 * The FromBuffer efficiently stores an "array of arrays", which for each instruction index (pc or
 * "program counter") tracks the pcs from which steps arrived at that instruction.
 *
 * To prevent allocation during the runtime of the whynot program, this data is stored in a single
 * Uint16Array. This buffer is sized to be able to hold for each pc the maximum number of incoming
 * steps, as derived from the program by ProgramInfo, as well as the current lengths of the
 * sub-array for each pc. The lower programLength entries contain these lengts, while the _mapping
 * array provides the offset at which each pcs data starts.
 */
class FromBuffer {
    /**
     * @param maxFromByPc - The maximum number of entries to reserve for each pc.
     */
    constructor(maxFromByPc) {
        this._mapping = [];
        let offset = maxFromByPc.length;
        maxFromByPc.forEach(max => {
            this._mapping.push(max > 0 ? offset : -1);
            offset += max;
        });
        // Allocate enough room for lengths and elements
        this._buffer = new Uint16Array(offset);
    }
    /**
     * Clear the buffer.
     *
     * This only resets the lengths, as that will make the data for each pc inaccessible.
     */
    clear() {
        this._buffer.fill(0, 0, this._mapping.length);
    }
    /**
     * Add an entry to the buffer.
     *
     * This method does not perform bounds checking, the caller should ensure no more entries are
     * added for each toPc than the maximum provided to the constructor.
     *
     * @param fromPc - The entry to add (the pc this step came from).
     * @param toPc   - The pc for which to add the entry.
     */
    add(fromPc, toPc) {
        const length = this._buffer[toPc];
        const offset = this._mapping[toPc];
        this._buffer[toPc] += 1;
        this._buffer[offset + length] = fromPc;
    }
    /**
     * Returns whether any entries have been added for the given pc.
     *
     * @param toPc - The pc to check entries for.
     */
    has(toPc) {
        const length = this._buffer[toPc];
        return length > 0;
    }
    /**
     * Iterates over the entries added for the given pc, (synchronously) invoking callback with the
     * value of each entry.
     *
     * @param toPc     - The entry whose values should be iterated over.
     * @param callback - Callback to invoke for each value.
     */
    forEach(toPc, callback) {
        const length = this._buffer[toPc];
        const offset = this._mapping[toPc];
        for (let i = offset; i < offset + length; ++i) {
            callback(this._buffer[i]);
        }
    }
}

/**
 * Returns the LazySet resulting from adding an item to the given LazySet.
 *
 * If item is already in set, always returns set.
 *
 * @param set            - The LazySet to add the item to
 * @param item           - The item to add
 * @param setIsImmutable - If left at false, when set is an array, item is pushed into the existing
 *                         array. If set to true, a new array will be allocated instead. This can be
 *                         used to prevent mutation of an existing set if you need to keep the
 *                         original value.
 */
function addToLazySet(set, item, setIsImmutable = false) {
    if (set === null) {
        return item;
    }
    if (Array.isArray(set)) {
        if (set.indexOf(item) === -1) {
            if (setIsImmutable) {
                set = set.slice();
            }
            set.push(item);
        }
        return set;
    }
    if (set === item) {
        return set;
    }
    return [set, item];
}
/**
 * Returns a LazySet representing the union of the given sets.
 *
 * @param set1            - First set
 * @param set2            - Second set
 * @param setIsImmutable - If left at false, when set1 is an array, items in set2 are pushed into
 *                         the existing array. If set to true, a new array will be allocated
 *                         instead. This can be used to prevent mutation of an existing set if you
 *                         need to keep the original value.
 */
function mergeLazySets(set1, set2, set1IsImmutable) {
    if (set1 === null) {
        return set2;
    }
    if (set2 === null) {
        return set1;
    }
    if (Array.isArray(set2)) {
        return set2.reduce((set, item) => addToLazySet(set, item, set === set2), set1);
    }
    return addToLazySet(set1, set2, set1IsImmutable);
}

/**
 * A Trace represents the execution history of a Thread in terms of the records gathered. Only paths
 * that differ in terms of these records are preserved.
 *
 * Trace is never cyclic (i.e., a given Trace is never included in its prefixes, including,
 * recursively, the prefixes thereof).
 *
 * Trace instances are often reused and should therefore never be mutated after creation.
 */
class Trace {
    constructor(prefixes, record) {
        this.prefixes = prefixes;
        this.record = record;
    }
}
/**
 * Single instance used to represent the empty trace from which all programs start.
 */
Trace.EMPTY = new Trace([], null);

/**
 * Create a trace only when necessary.
 *
 * Not adding records to a single prefix can be represented by the prefix itself. Similarly, adding
 * a record to only the empty trace can omit the empty trace from the prefixes of the new trace.
 *
 * Finally, if the LazySet of prefixes was already an array, this reuses that array in the trace,
 * avoiding an extra allocation.
 *
 * @param prefixes - Non-empty LazySet of Trace instances, representing the unique ways to get here
 * @param record   - Optional record to include in the Trace
 */
function createOrReuseTrace(prefixes, record) {
    let prefixesArray;
    if (record === null) {
        if (!Array.isArray(prefixes)) {
            return prefixes;
        }
        prefixesArray = prefixes;
    }
    else if (prefixes === Trace.EMPTY) {
        // No need to include empty prefixes on the new trace with a record
        prefixesArray = [];
    }
    else if (Array.isArray(prefixes)) {
        prefixesArray = prefixes;
    }
    else {
        prefixesArray = [prefixes];
    }
    return new Trace(prefixesArray, record);
}
/**
 * Handles updating Trace instances across each generation, while minimizing allocations.
 */
class Tracer {
    constructor(programLength) {
        this._stateByPc = [];
        this._prefixesByPc = [];
        for (let i = 0; i < programLength; ++i) {
            this._stateByPc.push(0 /* NOT_VISITED */);
            this._prefixesByPc.push(null);
        }
    }
    /**
     * Determines traces for each entry in startingFromBuffer for pc, and adds them to prefixes,
     * returning the resulting LazySet.
     *
     * Steps taken by trace() after the first step use the fromByPc FromBuffer instead of the
     * startingFromBuffer. This supports the fact that the first step is always from a survivor, so
     * should be taken in the survivor from buffer, while the rest of the steps are within the
     * generation.
     */
    mergeTraces(prefixes, pc, startingFromBuffer, previousTraceBySurvivorPc, fromByPc, recordByPc) {
        let isPrefixesReused = false;
        startingFromBuffer.forEach(pc, fromPc => {
            const traces = this.trace(fromPc, previousTraceBySurvivorPc, fromByPc, recordByPc);
            prefixes = mergeLazySets(prefixes, traces, isPrefixesReused);
            isPrefixesReused = prefixes === traces;
        });
        return prefixes;
    }
    /**
     * Determines traces leading to pc, stepping through fromByPc and using incoming traces (i.e.,
     * from a previous generation) from previousTraceBySurvivorPc.
     *
     * To prevent allocations, traces are represented as a LazySet of their prefixes for as long as
     * possible, which usually means until a record has to be added.
     *
     * @param pc                        - The pc from which to trace
     * @param previousTraceBySurvivorPc - Incoming traces (built up in the previous generation)
     * @param fromByPc                  - The FromBuffer to trace through
     * @param recordByPc                - Records to include when a trace passes through the
     *                                    corresponding pc.
     */
    trace(pc, previousTraceBySurvivorPc, fromByPc, recordByPc) {
        const state = this._stateByPc[pc];
        switch (state) {
            case 2 /* DONE */:
                return this._prefixesByPc[pc];
            case 1 /* IN_CURRENT_PATH */:
                // Trace is a cycle, ignore this path
                return null;
        }
        // Mark state to detect cycles
        this._stateByPc[pc] = 1 /* IN_CURRENT_PATH */;
        let prefixes = null;
        const startingTrace = previousTraceBySurvivorPc[pc];
        if (startingTrace !== null) {
            prefixes = startingTrace;
        }
        else if (!fromByPc.has(pc)) {
            throw new Error(`Trace without source at pc ${pc}`);
        }
        prefixes = this.mergeTraces(prefixes, pc, fromByPc, previousTraceBySurvivorPc, fromByPc, recordByPc);
        if (prefixes !== null) {
            // Valid prefixes found, check for records
            const record = recordByPc[pc];
            if (record !== null) {
                prefixes = createOrReuseTrace(prefixes, record);
            }
        }
        // Add to cache and mark as complete
        this._prefixesByPc[pc] = prefixes;
        this._stateByPc[pc] = 2 /* DONE */;
        return prefixes;
    }
    /**
     * Populates newTraceBySurvivorPc with traces constructed from tracing for any survivor (i.e.,
     * those pcs having any entries in fromBySurvivorPc). Tracing takes the first step in
     * fromBySurvivorPc and then proceeds through fromByPc until complete, gathering unique traces
     * by combining incoming traces (from previousTraceBySurvivorPc) with new records (from
     * recordByPc) gathered along the way.
     *
     * @param previousTraceBySurvivorPc - Incoming traces (built up in the previous generation)
     * @param newTraceBySurvivorPc      - Array to populate with new traces (or null for
     *                                    non-survivor pcs)
     * @param fromBySurvivorPc          - The FromBuffer with the final steps for each thread (from
     *                                    within the generation to being a survivor)
     * @param fromByPc                  - The FromBuffer with all other steps taken within the
     *                                    generation.
     * @param recordByPc                - Records generated during the generation.
     */
    buildSurvivorTraces(previousTraceBySurvivorPc, newTraceBySurvivorPc, fromBySurvivorPc, fromByPc, recordByPc) {
        for (let pc = 0, programLength = previousTraceBySurvivorPc.length; pc < programLength; ++pc) {
            if (!fromBySurvivorPc.has(pc)) {
                newTraceBySurvivorPc[pc] = null;
                continue;
            }
            // Some cached results may depend on detected cycles. The points at which a cycle should
            // no longer be followed differ between survivors, so these cached results are not
            // transferrable between them. To work around this, we reset the tracing state and cache
            // before tracing each survivor, and later deduplicate results in Traces.getTraces().
            this._prefixesByPc.fill(null);
            this._stateByPc.fill(0 /* NOT_VISITED */);
            const prefixes = this.mergeTraces(null, pc, fromBySurvivorPc, previousTraceBySurvivorPc, fromByPc, recordByPc);
            if (prefixes === null) {
                throw new Error(`No non-cyclic paths found to survivor ${pc}`);
            }
            newTraceBySurvivorPc[pc] = createOrReuseTrace(prefixes, null);
        }
        // Free prefix sets for GC
        this._prefixesByPc.fill(null);
    }
}

/**
 * Records information needed to build Trace instances after each generation concludes.
 */
class Traces {
    constructor(programInfo) {
        /**
         * Records generated, by pc, in the current generation
         */
        this._recordByPc = [];
        /**
         * Traces for anything that survived until the start of the generation, updated when the current
         * generation ends. Swaps with _nextTraceBySurvivorPc after each generation in order to minimize
         * allocations.
         */
        this._traceBySurvivorPc = [];
        /**
         * Array in which to build traces for the next generation when the current one ends. Swaps with
         * _traceBySurvivorPc after each generation in order to minimize allocations.
         */
        this._nextTraceBySurvivorPc = [];
        this._fromByPc = new FromBuffer(programInfo.maxFromByPc);
        this._fromBySurvivorPc = new FromBuffer(programInfo.maxSurvivorFromByPc);
        this._tracer = new Tracer(programInfo.programLength);
        for (let i = 0; i < programInfo.programLength; ++i) {
            this._recordByPc.push(null);
            this._traceBySurvivorPc.push(null);
            this._nextTraceBySurvivorPc.push(null);
        }
        this._traceBySurvivorPc[0] = Trace.EMPTY;
    }
    /**
     * Clear the instance after each generation or for a new run of the VM.
     *
     * @param clearSurvivors - Set to true to clear survivor traces when resetting for a new run.
     *                         Set to false when moving to the next generation to preserve these.
     */
    reset(clearSurvivors) {
        this._fromByPc.clear();
        this._fromBySurvivorPc.clear();
        this._recordByPc.fill(null);
        if (clearSurvivors) {
            this._traceBySurvivorPc.fill(null);
            this._nextTraceBySurvivorPc.fill(null);
            this._traceBySurvivorPc[0] = Trace.EMPTY;
        }
    }
    /**
     * Add a record for the current generation
     *
     * @param pc     - The pc of the record instruction this record originates from
     * @param record - The data to record
     */
    record(pc, record) {
        this._recordByPc[pc] = record;
    }
    /**
     * Returns whether the given instruction has already been visited during the current generation.
     *
     * This is determined by it having incoming entries in the corresponding FromBuffer, or by it
     * having an incoming trace from the previous generation.
     *
     * @param pc The pc to check.
     */
    has(pc) {
        return this._fromByPc.has(pc) || this._traceBySurvivorPc[pc] !== null;
    }
    /**
     * Record the given step within the current generation.
     *
     * @param fromPc - Origin of the step
     * @param toPc   - Target of the step
     */
    add(fromPc, toPc) {
        this._fromByPc.add(fromPc, toPc);
    }
    /**
     * Returns whether the given instruction has been stepped to for the next generation.
     *
     * This is determined by it having incoming entries in the corresponding FromBuffer.
     *
     * @param pc The pc to check.
     */
    hasSurvivor(pc) {
        return this._fromBySurvivorPc.has(pc);
    }
    /**
     * Record the given step from the current generation to the next.
     *
     * @param fromPc - Origin of the step
     * @param toPc   - Target of the step
     */
    addSurvivor(fromPc, toPc) {
        this._fromBySurvivorPc.add(fromPc, toPc);
    }
    /**
     * Builds traces for each survivor after a generation ends.
     *
     * Swaps the _traceBySurvivorPc and _nextTraceBySurvivorPc arrays afterwards to avoid
     * allocations.
     */
    buildSurvivorTraces() {
        const previousTraceBySurvivorPc = this._traceBySurvivorPc;
        this._tracer.buildSurvivorTraces(previousTraceBySurvivorPc, this._nextTraceBySurvivorPc, this._fromBySurvivorPc, this._fromByPc, this._recordByPc);
        // Swap arrays
        this._traceBySurvivorPc = this._nextTraceBySurvivorPc;
        this._nextTraceBySurvivorPc = previousTraceBySurvivorPc;
    }
    /**
     * Returns unique traces for all threads that reached accept after all input has been processed.
     *
     * Should be called after the last generation finishes.
     *
     * @param acceptedPcs - The pcs for which to compute traces. These should all have survived the
     *                      last generation.
     */
    getTraces(acceptedPcs) {
        const traces = acceptedPcs.reduce((traces, pc) => addToLazySet(traces, this._traceBySurvivorPc[pc]), null);
        if (traces === null) {
            return [];
        }
        return Array.isArray(traces) ? traces : [traces];
    }
}

/**
 * Responsible for tracking all execution state for a running VM.
 *
 * This manages scheduling of threads for the current and next generation using two instances of
 * Generation. It also handles tracking steps for the current generation and updating Trace
 * instances for any survivors (i.e., threads that made it to the next generation) using a Traces
 * instance.
 *
 * Note that threads are not represented directly. Generation only schedules program counter (pc)
 * values with a corresponding badness. Traces only tracks steps taken through the program. At the
 * end of all input, we're only interested in the unique paths taken to get there in terms of the
 * records collected along the way.
 */
class Scheduler {
    constructor(programInfo) {
        // PCs of accepted threads in the current generation
        this._acceptedPcs = [];
        this._currentGeneration = new Generation(programInfo.programLength);
        this._nextGeneration = new Generation(programInfo.programLength);
        this._traces = new Traces(programInfo);
    }
    /**
     * Clears all information for a new run of the program.
     */
    reset() {
        this._currentGeneration.reset();
        this._currentGeneration.add(0, 0);
        this._acceptedPcs.length = 0;
        this._traces.reset(true);
    }
    /**
     * Get the pc for the next thread to execute, or null if there are no more threads to run in the
     * current generation.
     */
    getNextThreadPc() {
        return this._currentGeneration.getNextPc();
    }
    /**
     * Step the thread forward, updating traces and scheduling the new thread in the current
     * generation.
     *
     * @param fromPc       - The current pc being executed
     * @param toPc         - The pc at which to continue
     * @param badnessDelta - The amount by which to increase badness for toPc
     */
    step(fromPc, toPc, badnessDelta) {
        const alreadyScheduled = this._traces.has(toPc);
        this._traces.add(fromPc, toPc);
        const badness = this._currentGeneration.getBadness(fromPc) + badnessDelta;
        if (alreadyScheduled) {
            this._currentGeneration.reschedule(toPc, badness);
            return;
        }
        // Schedule the next step
        this._currentGeneration.add(toPc, badness);
    }
    /**
     * Step the thread forward, updating traces and scheduling the new thread in the next
     * generation.
     *
     * @param fromPc       - The current pc being executed
     * @param toPc         - The pc at which to continue
     */
    stepToNextGeneration(fromPc, toPc) {
        const alreadyScheduled = this._traces.hasSurvivor(toPc);
        this._traces.addSurvivor(fromPc, toPc);
        const badness = this._currentGeneration.getBadness(fromPc);

        if (alreadyScheduled) {
			window.log('In the `if (alreadyScheduled) {...}` of stepToNextGeneration. With `alreadyScheduled` set to: '+ alreadyScheduled);
            this._nextGeneration.reschedule(toPc, badness);
            return;
        }
        this._nextGeneration.add(toPc, badness);
    }
    /**
     * Marks the thread ending at pc as successful (i.e., it executed an accept instruction when all
     * input has been processed). The trace for pc will be included in the result returned from
     * VM.execute().
     *
     * @param pc - The current pc being executed (corresponding to an accept instruction)
     */
    accept(pc) {
        this._acceptedPcs.push(pc);
        this._traces.addSurvivor(pc, pc);
    }
    /**
     * Marks the thread ending at pc as failed, i.e., it was stopped from continuing execution. This
     * could happen in the following cases:
     *
     * - it executed an accept instruction while not all input has been processed
     * - it executed a fail instruction (for which the callback returned true if there was one)
     * - it executed a test instruction for which the callback returned false
     * - it executed a jump instruction with no targets
     *
     * This does not currently do anything, but could be used to determine an explanation why input
     * was not accepted by the VM in a future version.
     *
     * @param _pc - The current pc being executed (corresponding to one of the cases mentioned)
     */
    fail(_pc) {
        // TODO: track failures as the combination of input x instruction?
    }
    /**
     * Adds a record for traces that include the pc.
     *
     * @param pc     - The pc for which to add the record, corresponding to a record instruction.
     * @param record - The record to add.
     */
    record(pc, record) {
        this._traces.record(pc, record);
    }
    /**
     * Updates traces for survivors and switches to the next generation. To be called when there are
     * no more threads scheduled in the current generation (i.e., getNextThreadPc returns null).
     */
    nextGeneration() {
        this._traces.buildSurvivorTraces();
        this._traces.reset(false);
        const gen = this._currentGeneration;
        gen.reset();
        this._currentGeneration = this._nextGeneration;
        this._nextGeneration = gen;
    }
    /**
     * Returns the unique traces for all accepted pcs. To be called after the generation for the
     * last input item has completed.
     */
    getAcceptingTraces() {
        return this._traces.getTraces(this._acceptedPcs);
    }
}

/**
 * A virtual machine to execute whynot programs.
 *
 * @public
 */
class VM {
    /**
     * @param program - The program to run, as created by the Assembler
     */
    constructor(program) {
        this._schedulers = [];
        this._program = program;
        this._programInfo = ProgramInfo.fromProgram(program);
        this._schedulers.push(new Scheduler(this._programInfo));
    }
    /**
     * Executes the program in the VM with the given input stream.
     *
     * @param input   - An array of input items.
     * @param options - Optional object passed to all instruction callbacks.
     *
     * @returns Result of the execution, containing all Traces that lead to acceptance of the input
     *          (if any)
     */
    execute(input, options) {
        const scheduler = this._schedulers.pop() || new Scheduler(this._programInfo);
        // Add initial thread
        scheduler.reset();
        const inputLength = input.length;
        let inputIndex = -1;
        let inputItem;
        do {
            // Get next thread to execute
            let pc = scheduler.getNextThreadPc();
            if (pc === null) {
                break;
            }
            // Read next input item
            ++inputIndex;
            inputItem = inputIndex >= inputLength ? null : input[inputIndex];
            while (pc !== null) {
                const instruction = this._program[pc];
                switch (instruction.op) {
                    case 0 /* ACCEPT */:
                        // Only accept if we reached the end of the input
                        if (inputItem === null) {
                            scheduler.accept(pc);
                        }
                        else {
                            scheduler.fail(pc);
                        }
                        break;
                    case 2 /* FAIL */: {
                        // Is the failure conditional?
                        const func = instruction.func;
                        const isFailingCondition = func === null || func(options);
                        if (isFailingCondition) {
                            // Branch is forbidden, end the thread
                            scheduler.fail(pc);
                            break;
                        }
                        // Condition failed, continue at next instruction
                        scheduler.step(pc, pc + 1, 0);
                        break;
                    }
                    case 1 /* BAD */:
                        // Continue at next pc with added badness
                        scheduler.step(pc, pc + 1, instruction.data);
                        break;
                    case 5 /* TEST */: {
                        // Fail if out of input
                        if (inputItem === null) {
                            scheduler.fail(pc);
                            break;
                        }
                        // Fail if input does not match
                        const func = instruction.func;
                        const isInputAccepted = func(inputItem, instruction.data, options);
                        if (!isInputAccepted) {
                            scheduler.fail(pc);
                            break;
                        }
                        // Continue in next generation, preserving badness
                        scheduler.stepToNextGeneration(pc, pc + 1);
                        break;
                    }
                    case 3 /* JUMP */: {
                        // Spawn new threads for all targets
                        const targetPcs = instruction.data;
                        const numTargets = targetPcs.length;
                        if (numTargets === 0) {
                            scheduler.fail(pc);
                            break;
                        }
                        for (let i = 0; i < numTargets; ++i) {
                            scheduler.step(pc, targetPcs[i], 0);
                        }
                        break;
                    }
                    case 4 /* RECORD */: {
                        // Invoke record callback
                        const func = instruction.func;
                        const record = func(instruction.data, inputIndex, options);
                        if (record !== null && record !== undefined) {
                            scheduler.record(pc, record);
                        }
                        // Continue with next instruction
                        scheduler.step(pc, pc + 1, 0);
                        break;
                    }
                }
                // Next thread
                pc = scheduler.getNextThreadPc();
            }
            // End current Generation and continue with the next
            scheduler.nextGeneration();
        } while (inputItem !== null);
        const result = new Result(scheduler.getAcceptingTraces());
        // Clear and recycle the scheduler
        scheduler.reset();
        this._schedulers.push(scheduler);
        return result;
    }
}

/**
 * Convenience helper function that creates a new VM using the specified callback for compilation.
 *
 * @public
 *
 * @param compile - Function used to compile the program, invoked with an Assembler as the only
 *                  parameter.
 *
 * @returns VM running the compiled program
 */
function compileVM(compile) {
    const assembler = new Assembler();
    compile(assembler);
    return new VM(assembler.program);
}
var index = { Assembler, VM, compileVM };

export { Assembler, VM, compileVM, index as default };
