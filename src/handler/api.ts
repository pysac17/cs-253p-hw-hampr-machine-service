import { DataCache } from "../database/cache";
import { MachineStateTable } from "../database/table";
import { IdentityProviderClient } from "../external/idp";
import { SmartMachineClient } from "../external/smart-machine";
import { GetMachineRequestModel, HttpResponseCode, MachineResponseModel, RequestMachineRequestModel, RequestModel, StartMachineRequestModel } from "./model";
import { MachineStateDocument, MachineStatus } from "../database/schema";
/**
 * Handles API requests for machine operations.
 * This class is responsible for routing requests to the appropriate handlers
 * and managing the overall workflow of machine interactions.
 */
export class ApiHandler {
    private cache: DataCache<MachineStateDocument>;
    constructor() {
        this.cache = DataCache.getInstance<MachineStateDocument>();
    }

    /**
     * Validates an authentication token.
     * @param token The token to validate.
     * @throws An error if the token is invalid.
     */
    private checkToken(token: string) {
        const idp = IdentityProviderClient.getInstance();
        const valid = idp.validateToken(token);
        if (!valid) {
            throw new Error(JSON.stringify({
                statusCode: HttpResponseCode.UNAUTHORIZED,
                message: 'Invalid token',
            }));
        }
    }

    /**
     * Handles a request to find and reserve an available machine at a specific location.
     * It finds an available machine, updates its status to AWAITING_DROPOFF,
     * assigns the job ID, and caches the updated machine state.
     * NOTE: The current implementation assumes a machine will be held for a certain period,
     * but there is no mechanism to release the hold if the user doesn't proceed.
     * @param request The request model containing location and job IDs.
     * @returns A response model with the status code and the reserved machine's state.
     */
    private handleRequestMachine(request: RequestMachineRequestModel): MachineResponseModel {
        const db = MachineStateTable.getInstance();

        const machines = db.listMachinesAtLocation(request.locationId);
        const available = machines.find(m => m.status === MachineStatus.AVAILABLE);
        if (!available) {
            return { statusCode: HttpResponseCode.NOT_FOUND };
        }

        db.updateMachineStatus(available.machineId, MachineStatus.AWAITING_DROPOFF);
        db.updateMachineJobId(available.machineId, request.jobId);

        const updated = db.getMachine(available.machineId);
        if (updated) {
            this.cache.put(updated.machineId, updated);
            return { statusCode: HttpResponseCode.OK, machine: updated };
        }

        return { statusCode: HttpResponseCode.INTERNAL_SERVER_ERROR };
    }


    /**
     * Retrieves the state of a specific machine.
     * It first checks the cache for the machine's data and, if not found, fetches it from the database.
     * @param request The request model containing the machine ID.
     * @returns A response model with the status code and the machine's state.
     */
    private handleGetMachine(request: GetMachineRequestModel): MachineResponseModel {
        const cached = this.cache.get(request.machineId);
        if (cached) {
            return { statusCode: HttpResponseCode.OK, machine: cached };
        }

        const db = MachineStateTable.getInstance();
        const machine = db.getMachine(request.machineId);
        if (!machine) {
            return { statusCode: HttpResponseCode.NOT_FOUND };
        }

        this.cache.put(request.machineId, machine);
        return { statusCode: HttpResponseCode.OK, machine };
    }

    /**
     * Starts the cycle of a machine that is awaiting drop-off.
     * It validates the machine's status, calls the external Smart Machine API to start the cycle,
     * and updates the machine's status to RUNNING.
     * @param request The request model containing the machine ID.
     * @returns A response model with the status code and the updated machine's state.
     */
    private handleStartMachine(request: StartMachineRequestModel): MachineResponseModel {
        const db = MachineStateTable.getInstance();
        const sm = SmartMachineClient.getInstance();

        const machine = db.getMachine(request.machineId);
        if (!machine) {
            return { statusCode: HttpResponseCode.NOT_FOUND };
        }

        if (machine.status !== MachineStatus.AWAITING_DROPOFF) {
            return { statusCode: HttpResponseCode.BAD_REQUEST, machine };
        }

        try {
            sm.startCycle(request.machineId);
            db.updateMachineStatus(request.machineId, MachineStatus.RUNNING);
            const updated = db.getMachine(request.machineId);
            if (updated) {
                this.cache.put(request.machineId, updated);
                return { statusCode: HttpResponseCode.OK, machine: updated };
            }
            return { statusCode: HttpResponseCode.INTERNAL_SERVER_ERROR };
        } catch {
            db.updateMachineStatus(request.machineId, MachineStatus.ERROR);
            const errored = db.getMachine(request.machineId);
            if (errored) {
                this.cache.put(request.machineId, errored);
                return { statusCode: HttpResponseCode.HARDWARE_ERROR, machine: errored };
            }
            return { statusCode: HttpResponseCode.INTERNAL_SERVER_ERROR };
        }
    }

    /**
     * The main entry point for handling all API requests.
     * It validates the token and routes the request to the appropriate private handler based on the method and path.
     * @param request The incoming request model.
     * @returns A response model from one of the specific handlers, or an error response.
     */
    public handle(request: RequestModel) {
        this.checkToken(request.token);

        if (request.method === 'POST' && request.path === '/machine/request') {
            return this.handleRequestMachine(request as RequestMachineRequestModel);
        }

        const getMachineMatch = request.path.match(/^\/machine\/([a-zA-Z0-9-]+)$/);
        if (request.method === 'GET' && getMachineMatch) {
            const machineId = getMachineMatch[1];
            const getRequest = { ...request, machineId } as GetMachineRequestModel;
            return this.handleGetMachine(getRequest);
        }

        const startMachineMatch = request.path.match(/^\/machine\/([a-zA-Z0-9-]+)\/start$/);
        if (request.method === 'POST' && startMachineMatch) { 
            const machineId = startMachineMatch[1];
            const startRequest = { ...request, machineId } as StartMachineRequestModel;
            return this.handleStartMachine(startRequest);
        }

        return { statusCode: HttpResponseCode.INTERNAL_SERVER_ERROR, machine: null };
    }
    
}