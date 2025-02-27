import axios, {AxiosInstance, AxiosRequestConfig, AxiosResponse} from "axios";

// Types

export interface AxiosAuthRefreshOptions {
    instance?: AxiosInstance;
    statusCodes?: Array<number>;
    skipWhileRefreshing?: boolean;
}

export interface AxiosAuthRefreshCache {
    skipInstances: AxiosInstance[];
    refreshCall: Promise<any>|undefined;
    requestQueueInterceptorId: number|undefined;
}

export interface AxiosAuthRefreshRequestConfig extends AxiosRequestConfig {
    skipAuthRefresh?: boolean;
}

// Constants

const defaultOptions: AxiosAuthRefreshOptions = {
    statusCodes: [ 401 ],
    instance: undefined,
    skipWhileRefreshing: true,
};

const cache: AxiosAuthRefreshCache = {
    skipInstances: [],
    refreshCall: undefined,
    requestQueueInterceptorId: undefined,
};

/**
 * Creates an authentication refresh interceptor that binds to any error response.
 * If the response status code is one of the options.statusCodes, interceptor calls the refreshAuthCall
 * which must return a Promise. While refreshAuthCall is running, all the new requests are intercepted and are waiting
 * for the refresh call to resolve. While running the refreshing call, instance provided is marked as a paused instance
 * which indicates the interceptor to not intercept any responses from it. This is because you'd otherwise need to mark
 * the specific requests you make by yourself in order to make sure it's not intercepted. This behavior can be
 * turned off, but use it with caution as you need to mark the requests with `skipAuthRefresh` flag yourself in order to
 * not run into interceptors loop.
 *
 * @param {AxiosInstance} instance - Axios HTTP client instance
 * @param {(error: any) => Promise<AxiosPromise>} refreshAuthCall - refresh token call which must return a Promise
 * @param {AxiosAuthRefreshOptions} options - options for the interceptor @see defaultOptions
 * @return {number} - interceptor id (in case you want to eject it manually)
 */
export default function createAuthRefreshInterceptor(
    instance: AxiosInstance,
    refreshAuthCall: (error: any) => Promise<any>,
    options: AxiosAuthRefreshOptions = {},
): number {
    if (typeof refreshAuthCall !== 'function') {
        throw new Error('axios-auth-refresh requires `refreshAuthCall` to be a function that returns a promise.');
    }

    return instance.interceptors.response.use((response: AxiosResponse) => response, (error: any) => {

        // Rewrite default options
        options = mergeOptions(defaultOptions, options);

        // Reject promise if the error status is not in options.ports
        if (!shouldInterceptError(error, options, instance, cache)) {
            return Promise.reject(error);
        }

        // If refresh call does not exist, create one
        cache.skipInstances.push(instance);
        const refreshing = createRefreshCall(error, refreshAuthCall, cache);

        // Create interceptor that will bind all the others requests until refreshAuthCall is resolved
        createRequestQueueInterceptor(instance, cache);

        return refreshing
            .finally(() => unsetCache(instance, cache))
            .catch(error => {
                return Promise.reject(error);
            })
            .then(() => {
                error.config.skipAuthRefresh = true;
                return axios(error.response.config);
            });
    });
}

/**
 * Merges two options objects (master rewrites slave).
 *
 * @return {AxiosAuthRefreshOptions}
 */
export function mergeOptions(
    slave: AxiosAuthRefreshOptions,
    master: AxiosAuthRefreshOptions,
): AxiosAuthRefreshOptions {
    return { ...slave, ...master };
}

/**
 * Returns TRUE: when error.response.status is contained in options.statusCodes
 * Returns FALSE: when error or error.response doesn't exist or options.statusCodes doesn't include response status
 *
 * @return {boolean}
 */
export function shouldInterceptError(
    error: any,
    options: AxiosAuthRefreshOptions,
    instance: AxiosInstance,
    cache: AxiosAuthRefreshCache,
): boolean {
    if (!error) {
        return false;
    }

    if (error.config && error.config.skipAuthRefresh) {
        return false;
    }

    if (!error.response || !options.statusCodes.includes(parseInt(error.response.status))) {
        return false;
    }

    return !options.skipWhileRefreshing || !cache.skipInstances.includes(instance);
}

/**
 * Creates refresh call if it does not exist or returns the existing one.
 *
 * @return {Promise<any>}
 */
export function createRefreshCall(
    error: any,
    fn: (error: any) => Promise<any>,
    cache: AxiosAuthRefreshCache,
): Promise<any> {
    if (!cache.refreshCall) {
        cache.refreshCall = fn(error);
        if (typeof cache.refreshCall.then !== 'function') {
            console.warn('axios-auth-refresh requires `refreshTokenCall` to return a promise.');
            return Promise.reject();
        }
    }
    return cache.refreshCall;
}

/**
 * Creates request queue interceptor if it does not exist and returns its id.
 *
 * @return {number}
 */
export function createRequestQueueInterceptor(
    instance: AxiosInstance,
    cache: AxiosAuthRefreshCache,
): number {
    if (typeof cache.requestQueueInterceptorId === 'undefined') {
        cache.requestQueueInterceptorId = instance.interceptors.request.use((request) => {
            return cache.refreshCall
                .catch(() => {
                    throw new axios.Cancel("Request call failed");
                })
                .then(() => request);
        });
    }
    return cache.requestQueueInterceptorId;
}

/**
 * Ejects request queue interceptor and unset interceptor cached values.
 *
 * @param {AxiosInstance} instance
 * @param {AxiosAuthRefreshCache} cache
 */
export function unsetCache(
    instance: AxiosInstance,
    cache: AxiosAuthRefreshCache,
): void {
    instance.interceptors.request.eject(cache.requestQueueInterceptorId);
    cache.requestQueueInterceptorId = undefined;
    cache.refreshCall = undefined;
    cache.skipInstances = cache.skipInstances.filter(skipInstance => skipInstance !== instance);
}
