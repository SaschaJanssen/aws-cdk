"use strict";
/* eslint-disable max-len */
/* eslint-disable no-console */
const cfnResponse = require("./cfn-response");
const consts = require("./consts");
const outbound_1 = require("./outbound");
const util_1 = require("./util");
/**
 * The main runtime entrypoint of the async custom resource lambda function.
 *
 * Any lifecycle event changes to the custom resources will invoke this handler, which will, in turn,
 * interact with the user-defined `onEvent` and `isComplete` handlers.
 *
 * This function will always succeed. If an error occurs, it is logged but an error is not thrown.
 *
 * @param cfnRequest The cloudformation custom resource event.
 */
async function onEvent(cfnRequest) {
    const sanitizedRequest = { ...cfnRequest, ResponseURL: '...' };
    (0, util_1.log)('onEventHandler', sanitizedRequest);
    cfnRequest.ResourceProperties = cfnRequest.ResourceProperties || {};
    const onEventResult = await invokeUserFunction(consts.USER_ON_EVENT_FUNCTION_ARN_ENV, sanitizedRequest, cfnRequest.ResponseURL);
    (0, util_1.log)('onEvent returned:', onEventResult);
    // merge the request and the result from onEvent to form the complete resource event
    // this also performs validation.
    const resourceEvent = createResponseEvent(cfnRequest, onEventResult);
    (0, util_1.log)('event:', onEventResult);
    // determine if this is an async provider based on whether we have an isComplete handler defined.
    // if it is not defined, then we are basically ready to return a positive response.
    if (!process.env[consts.USER_IS_COMPLETE_FUNCTION_ARN_ENV]) {
        return cfnResponse.submitResponse('SUCCESS', resourceEvent, { noEcho: resourceEvent.NoEcho });
    }
    // ok, we are not complete, so kick off the waiter workflow
    const waiter = {
        stateMachineArn: (0, util_1.getEnv)(consts.WAITER_STATE_MACHINE_ARN_ENV),
        name: resourceEvent.RequestId,
        input: JSON.stringify(resourceEvent),
    };
    (0, util_1.log)('starting waiter', {
        stateMachineArn: (0, util_1.getEnv)(consts.WAITER_STATE_MACHINE_ARN_ENV),
        name: resourceEvent.RequestId,
    });
    // kick off waiter state machine
    await (0, outbound_1.startExecution)(waiter);
}
// invoked a few times until `complete` is true or until it times out.
async function isComplete(event) {
    const sanitizedRequest = { ...event, ResponseURL: '...' };
    (0, util_1.log)('isComplete', sanitizedRequest);
    const isCompleteResult = await invokeUserFunction(consts.USER_IS_COMPLETE_FUNCTION_ARN_ENV, sanitizedRequest, event.ResponseURL);
    (0, util_1.log)('user isComplete returned:', isCompleteResult);
    // if we are not complete, return false, and don't send a response back.
    if (!isCompleteResult.IsComplete) {
        if (isCompleteResult.Data && Object.keys(isCompleteResult.Data).length > 0) {
            throw new Error('"Data" is not allowed if "IsComplete" is "False"');
        }
        // This must be the full event, it will be deserialized in `onTimeout` to send the response to CloudFormation
        throw new cfnResponse.Retry(JSON.stringify(event));
    }
    const response = {
        ...event,
        ...isCompleteResult,
        Data: {
            ...event.Data,
            ...isCompleteResult.Data,
        },
    };
    await cfnResponse.submitResponse('SUCCESS', response, { noEcho: event.NoEcho });
}
// invoked when completion retries are exhaused.
async function onTimeout(timeoutEvent) {
    (0, util_1.log)('timeoutHandler', timeoutEvent);
    const isCompleteRequest = JSON.parse(JSON.parse(timeoutEvent.Cause).errorMessage);
    await cfnResponse.submitResponse('FAILED', isCompleteRequest, {
        reason: 'Operation timed out',
    });
}
async function invokeUserFunction(functionArnEnv, sanitizedPayload, responseUrl) {
    const functionArn = (0, util_1.getEnv)(functionArnEnv);
    (0, util_1.log)(`executing user function ${functionArn} with payload`, sanitizedPayload);
    // transient errors such as timeouts, throttling errors (429), and other
    // errors that aren't caused by a bad request (500 series) are retried
    // automatically by the JavaScript SDK.
    const resp = await (0, outbound_1.invokeFunction)({
        FunctionName: functionArn,
        // Cannot strip 'ResponseURL' here as this would be a breaking change even though the downstream CR doesn't need it
        Payload: JSON.stringify({ ...sanitizedPayload, ResponseURL: responseUrl }),
    });
    (0, util_1.log)('user function response:', resp, typeof (resp));
    // ParseJsonPayload is very defensive. It should not be possible for `Payload`
    // to be anything other than a JSON encoded string (or intarray). Something weird is
    // going on if that happens. Still, we should do our best to survive it.
    const jsonPayload = (0, util_1.parseJsonPayload)(resp.Payload);
    if (resp.FunctionError) {
        (0, util_1.log)('user function threw an error:', resp.FunctionError);
        const errorMessage = jsonPayload.errorMessage || 'error';
        // parse function name from arn
        // arn:${Partition}:lambda:${Region}:${Account}:function:${FunctionName}
        const arn = functionArn.split(':');
        const functionName = arn[arn.length - 1];
        // append a reference to the log group.
        const message = [
            errorMessage,
            '',
            `Logs: /aws/lambda/${functionName}`, // cloudwatch log group
            '',
        ].join('\n');
        const e = new Error(message);
        // the output that goes to CFN is what's in `stack`, not the error message.
        // if we have a remote trace, construct a nice message with log group information
        if (jsonPayload.trace) {
            // skip first trace line because it's the message
            e.stack = [message, ...jsonPayload.trace.slice(1)].join('\n');
        }
        throw e;
    }
    return jsonPayload;
}
function createResponseEvent(cfnRequest, onEventResult) {
    //
    // validate that onEventResult always includes a PhysicalResourceId
    onEventResult = onEventResult || {};
    // if physical ID is not returned, we have some defaults for you based
    // on the request type.
    const physicalResourceId = onEventResult.PhysicalResourceId || defaultPhysicalResourceId(cfnRequest);
    // if we are in DELETE and physical ID was changed, it's an error.
    if (cfnRequest.RequestType === 'Delete' && physicalResourceId !== cfnRequest.PhysicalResourceId) {
        throw new Error(`DELETE: cannot change the physical resource ID from "${cfnRequest.PhysicalResourceId}" to "${onEventResult.PhysicalResourceId}" during deletion`);
    }
    // if we are in UPDATE and physical ID was changed, it's a replacement (just log)
    if (cfnRequest.RequestType === 'Update' && physicalResourceId !== cfnRequest.PhysicalResourceId) {
        (0, util_1.log)(`UPDATE: changing physical resource ID from "${cfnRequest.PhysicalResourceId}" to "${onEventResult.PhysicalResourceId}"`);
    }
    // merge request event and result event (result prevails).
    return {
        ...cfnRequest,
        ...onEventResult,
        PhysicalResourceId: physicalResourceId,
    };
}
/**
 * Calculates the default physical resource ID based in case user handler did
 * not return a PhysicalResourceId.
 *
 * For "CREATE", it uses the RequestId.
 * For "UPDATE" and "DELETE" and returns the current PhysicalResourceId (the one provided in `event`).
 */
function defaultPhysicalResourceId(req) {
    switch (req.RequestType) {
        case 'Create':
            return req.RequestId;
        case 'Update':
        case 'Delete':
            return req.PhysicalResourceId;
        default:
            throw new Error(`Invalid "RequestType" in request "${JSON.stringify(req)}"`);
    }
}
module.exports = {
    [consts.FRAMEWORK_ON_EVENT_HANDLER_NAME]: cfnResponse.safeHandler(onEvent),
    [consts.FRAMEWORK_IS_COMPLETE_HANDLER_NAME]: cfnResponse.safeHandler(isComplete),
    [consts.FRAMEWORK_ON_TIMEOUT_HANDLER_NAME]: onTimeout,
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZnJhbWV3b3JrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZnJhbWV3b3JrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQSw0QkFBNEI7QUFDNUIsK0JBQStCO0FBQy9CLDhDQUE4QztBQUM5QyxtQ0FBbUM7QUFDbkMseUNBQTREO0FBQzVELGlDQUF1RDtBQVV2RDs7Ozs7Ozs7O0dBU0c7QUFDSCxLQUFLLFVBQVUsT0FBTyxDQUFDLFVBQXVEO0lBQzVFLE1BQU0sZ0JBQWdCLEdBQUcsRUFBRSxHQUFHLFVBQVUsRUFBRSxXQUFXLEVBQUUsS0FBSyxFQUFXLENBQUM7SUFDeEUsSUFBQSxVQUFHLEVBQUMsZ0JBQWdCLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztJQUV4QyxVQUFVLENBQUMsa0JBQWtCLEdBQUcsVUFBVSxDQUFDLGtCQUFrQixJQUFJLEVBQUcsQ0FBQztJQUVyRSxNQUFNLGFBQWEsR0FBRyxNQUFNLGtCQUFrQixDQUFDLE1BQU0sQ0FBQyw4QkFBOEIsRUFBRSxnQkFBZ0IsRUFBRSxVQUFVLENBQUMsV0FBVyxDQUFvQixDQUFDO0lBQ25KLElBQUEsVUFBRyxFQUFDLG1CQUFtQixFQUFFLGFBQWEsQ0FBQyxDQUFDO0lBRXhDLG9GQUFvRjtJQUNwRixpQ0FBaUM7SUFDakMsTUFBTSxhQUFhLEdBQUcsbUJBQW1CLENBQUMsVUFBVSxFQUFFLGFBQWEsQ0FBQyxDQUFDO0lBQ3JFLElBQUEsVUFBRyxFQUFDLFFBQVEsRUFBRSxhQUFhLENBQUMsQ0FBQztJQUU3QixpR0FBaUc7SUFDakcsbUZBQW1GO0lBQ25GLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxpQ0FBaUMsQ0FBQyxFQUFFLENBQUM7UUFDM0QsT0FBTyxXQUFXLENBQUMsY0FBYyxDQUFDLFNBQVMsRUFBRSxhQUFhLEVBQUUsRUFBRSxNQUFNLEVBQUUsYUFBYSxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUM7SUFDaEcsQ0FBQztJQUVELDJEQUEyRDtJQUMzRCxNQUFNLE1BQU0sR0FBRztRQUNiLGVBQWUsRUFBRSxJQUFBLGFBQU0sRUFBQyxNQUFNLENBQUMsNEJBQTRCLENBQUM7UUFDNUQsSUFBSSxFQUFFLGFBQWEsQ0FBQyxTQUFTO1FBQzdCLEtBQUssRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLGFBQWEsQ0FBQztLQUNyQyxDQUFDO0lBRUYsSUFBQSxVQUFHLEVBQUMsaUJBQWlCLEVBQUU7UUFDckIsZUFBZSxFQUFFLElBQUEsYUFBTSxFQUFDLE1BQU0sQ0FBQyw0QkFBNEIsQ0FBQztRQUM1RCxJQUFJLEVBQUUsYUFBYSxDQUFDLFNBQVM7S0FDOUIsQ0FBQyxDQUFDO0lBRUgsZ0NBQWdDO0lBQ2hDLE1BQU0sSUFBQSx5QkFBYyxFQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQy9CLENBQUM7QUFFRCxzRUFBc0U7QUFDdEUsS0FBSyxVQUFVLFVBQVUsQ0FBQyxLQUFrRDtJQUMxRSxNQUFNLGdCQUFnQixHQUFHLEVBQUUsR0FBRyxLQUFLLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBVyxDQUFDO0lBQ25FLElBQUEsVUFBRyxFQUFDLFlBQVksRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO0lBRXBDLE1BQU0sZ0JBQWdCLEdBQUcsTUFBTSxrQkFBa0IsQ0FBQyxNQUFNLENBQUMsaUNBQWlDLEVBQUUsZ0JBQWdCLEVBQUUsS0FBSyxDQUFDLFdBQVcsQ0FBdUIsQ0FBQztJQUN2SixJQUFBLFVBQUcsRUFBQywyQkFBMkIsRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO0lBRW5ELHdFQUF3RTtJQUN4RSxJQUFJLENBQUMsZ0JBQWdCLENBQUMsVUFBVSxFQUFFLENBQUM7UUFDakMsSUFBSSxnQkFBZ0IsQ0FBQyxJQUFJLElBQUksTUFBTSxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDM0UsTUFBTSxJQUFJLEtBQUssQ0FBQyxrREFBa0QsQ0FBQyxDQUFDO1FBQ3RFLENBQUM7UUFFRCw2R0FBNkc7UUFDN0csTUFBTSxJQUFJLFdBQVcsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQ3JELENBQUM7SUFFRCxNQUFNLFFBQVEsR0FBRztRQUNmLEdBQUcsS0FBSztRQUNSLEdBQUcsZ0JBQWdCO1FBQ25CLElBQUksRUFBRTtZQUNKLEdBQUcsS0FBSyxDQUFDLElBQUk7WUFDYixHQUFHLGdCQUFnQixDQUFDLElBQUk7U0FDekI7S0FDRixDQUFDO0lBRUYsTUFBTSxXQUFXLENBQUMsY0FBYyxDQUFDLFNBQVMsRUFBRSxRQUFRLEVBQUUsRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUM7QUFDbEYsQ0FBQztBQUVELGdEQUFnRDtBQUNoRCxLQUFLLFVBQVUsU0FBUyxDQUFDLFlBQWlCO0lBQ3hDLElBQUEsVUFBRyxFQUFDLGdCQUFnQixFQUFFLFlBQVksQ0FBQyxDQUFDO0lBRXBDLE1BQU0saUJBQWlCLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQyxZQUFZLENBQWdELENBQUM7SUFDakksTUFBTSxXQUFXLENBQUMsY0FBYyxDQUFDLFFBQVEsRUFBRSxpQkFBaUIsRUFBRTtRQUM1RCxNQUFNLEVBQUUscUJBQXFCO0tBQzlCLENBQUMsQ0FBQztBQUNMLENBQUM7QUFFRCxLQUFLLFVBQVUsa0JBQWtCLENBQW1DLGNBQXNCLEVBQUUsZ0JBQW1CLEVBQUUsV0FBbUI7SUFDbEksTUFBTSxXQUFXLEdBQUcsSUFBQSxhQUFNLEVBQUMsY0FBYyxDQUFDLENBQUM7SUFDM0MsSUFBQSxVQUFHLEVBQUMsMkJBQTJCLFdBQVcsZUFBZSxFQUFFLGdCQUFnQixDQUFDLENBQUM7SUFFN0Usd0VBQXdFO0lBQ3hFLHNFQUFzRTtJQUN0RSx1Q0FBdUM7SUFDdkMsTUFBTSxJQUFJLEdBQUcsTUFBTSxJQUFBLHlCQUFjLEVBQUM7UUFDaEMsWUFBWSxFQUFFLFdBQVc7UUFFekIsbUhBQW1IO1FBQ25ILE9BQU8sRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsR0FBRyxnQkFBZ0IsRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLENBQUM7S0FDM0UsQ0FBQyxDQUFDO0lBRUgsSUFBQSxVQUFHLEVBQUMseUJBQXlCLEVBQUUsSUFBSSxFQUFFLE9BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO0lBRW5ELDhFQUE4RTtJQUM5RSxvRkFBb0Y7SUFDcEYsd0VBQXdFO0lBQ3hFLE1BQU0sV0FBVyxHQUFHLElBQUEsdUJBQWdCLEVBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ25ELElBQUksSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO1FBQ3ZCLElBQUEsVUFBRyxFQUFDLCtCQUErQixFQUFFLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUV6RCxNQUFNLFlBQVksR0FBRyxXQUFXLENBQUMsWUFBWSxJQUFJLE9BQU8sQ0FBQztRQUV6RCwrQkFBK0I7UUFDL0Isd0VBQXdFO1FBQ3hFLE1BQU0sR0FBRyxHQUFHLFdBQVcsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDbkMsTUFBTSxZQUFZLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUM7UUFFekMsdUNBQXVDO1FBQ3ZDLE1BQU0sT0FBTyxHQUFHO1lBQ2QsWUFBWTtZQUNaLEVBQUU7WUFDRixxQkFBcUIsWUFBWSxFQUFFLEVBQUUsdUJBQXVCO1lBQzVELEVBQUU7U0FDSCxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUViLE1BQU0sQ0FBQyxHQUFHLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBRTdCLDJFQUEyRTtRQUMzRSxpRkFBaUY7UUFDakYsSUFBSSxXQUFXLENBQUMsS0FBSyxFQUFFLENBQUM7WUFDdEIsaURBQWlEO1lBQ2pELENBQUMsQ0FBQyxLQUFLLEdBQUcsQ0FBQyxPQUFPLEVBQUUsR0FBRyxXQUFXLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUNoRSxDQUFDO1FBRUQsTUFBTSxDQUFDLENBQUM7SUFDVixDQUFDO0lBRUQsT0FBTyxXQUFXLENBQUM7QUFDckIsQ0FBQztBQUVELFNBQVMsbUJBQW1CLENBQUMsVUFBdUQsRUFBRSxhQUE4QjtJQUNsSCxFQUFFO0lBQ0YsbUVBQW1FO0lBRW5FLGFBQWEsR0FBRyxhQUFhLElBQUksRUFBRyxDQUFDO0lBRXJDLHNFQUFzRTtJQUN0RSx1QkFBdUI7SUFDdkIsTUFBTSxrQkFBa0IsR0FBRyxhQUFhLENBQUMsa0JBQWtCLElBQUkseUJBQXlCLENBQUMsVUFBVSxDQUFDLENBQUM7SUFFckcsa0VBQWtFO0lBQ2xFLElBQUksVUFBVSxDQUFDLFdBQVcsS0FBSyxRQUFRLElBQUksa0JBQWtCLEtBQUssVUFBVSxDQUFDLGtCQUFrQixFQUFFLENBQUM7UUFDaEcsTUFBTSxJQUFJLEtBQUssQ0FBQyx3REFBd0QsVUFBVSxDQUFDLGtCQUFrQixTQUFTLGFBQWEsQ0FBQyxrQkFBa0IsbUJBQW1CLENBQUMsQ0FBQztJQUNySyxDQUFDO0lBRUQsaUZBQWlGO0lBQ2pGLElBQUksVUFBVSxDQUFDLFdBQVcsS0FBSyxRQUFRLElBQUksa0JBQWtCLEtBQUssVUFBVSxDQUFDLGtCQUFrQixFQUFFLENBQUM7UUFDaEcsSUFBQSxVQUFHLEVBQUMsK0NBQStDLFVBQVUsQ0FBQyxrQkFBa0IsU0FBUyxhQUFhLENBQUMsa0JBQWtCLEdBQUcsQ0FBQyxDQUFDO0lBQ2hJLENBQUM7SUFFRCwwREFBMEQ7SUFDMUQsT0FBTztRQUNMLEdBQUcsVUFBVTtRQUNiLEdBQUcsYUFBYTtRQUNoQixrQkFBa0IsRUFBRSxrQkFBa0I7S0FDdkMsQ0FBQztBQUNKLENBQUM7QUFFRDs7Ozs7O0dBTUc7QUFDSCxTQUFTLHlCQUF5QixDQUFDLEdBQWdEO0lBQ2pGLFFBQVEsR0FBRyxDQUFDLFdBQVcsRUFBRSxDQUFDO1FBQ3hCLEtBQUssUUFBUTtZQUNYLE9BQU8sR0FBRyxDQUFDLFNBQVMsQ0FBQztRQUV2QixLQUFLLFFBQVEsQ0FBQztRQUNkLEtBQUssUUFBUTtZQUNYLE9BQU8sR0FBRyxDQUFDLGtCQUFrQixDQUFDO1FBRWhDO1lBQ0UsTUFBTSxJQUFJLEtBQUssQ0FBQyxxQ0FBcUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDakYsQ0FBQztBQUNILENBQUM7QUFoTUQsaUJBQVM7SUFDUCxDQUFDLE1BQU0sQ0FBQywrQkFBK0IsQ0FBQyxFQUFFLFdBQVcsQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDO0lBQzFFLENBQUMsTUFBTSxDQUFDLGtDQUFrQyxDQUFDLEVBQUUsV0FBVyxDQUFDLFdBQVcsQ0FBQyxVQUFVLENBQUM7SUFDaEYsQ0FBQyxNQUFNLENBQUMsaUNBQWlDLENBQUMsRUFBRSxTQUFTO0NBQ3RELENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKiBlc2xpbnQtZGlzYWJsZSBtYXgtbGVuICovXG4vKiBlc2xpbnQtZGlzYWJsZSBuby1jb25zb2xlICovXG5pbXBvcnQgKiBhcyBjZm5SZXNwb25zZSBmcm9tICcuL2Nmbi1yZXNwb25zZSc7XG5pbXBvcnQgKiBhcyBjb25zdHMgZnJvbSAnLi9jb25zdHMnO1xuaW1wb3J0IHsgaW52b2tlRnVuY3Rpb24sIHN0YXJ0RXhlY3V0aW9uIH0gZnJvbSAnLi9vdXRib3VuZCc7XG5pbXBvcnQgeyBnZXRFbnYsIGxvZywgcGFyc2VKc29uUGF5bG9hZCB9IGZyb20gJy4vdXRpbCc7XG5pbXBvcnQgeyBJc0NvbXBsZXRlUmVzcG9uc2UsIE9uRXZlbnRSZXNwb25zZSB9IGZyb20gJy4uL3R5cGVzJztcblxuLy8gdXNlIGNvbnN0cyBmb3IgaGFuZGxlciBuYW1lcyB0byBjb21waWxlci1lbmZvcmNlIHRoZSBjb3VwbGluZyB3aXRoIGNvbnN0cnVjdGlvbiBjb2RlLlxuZXhwb3J0ID0ge1xuICBbY29uc3RzLkZSQU1FV09SS19PTl9FVkVOVF9IQU5ETEVSX05BTUVdOiBjZm5SZXNwb25zZS5zYWZlSGFuZGxlcihvbkV2ZW50KSxcbiAgW2NvbnN0cy5GUkFNRVdPUktfSVNfQ09NUExFVEVfSEFORExFUl9OQU1FXTogY2ZuUmVzcG9uc2Uuc2FmZUhhbmRsZXIoaXNDb21wbGV0ZSksXG4gIFtjb25zdHMuRlJBTUVXT1JLX09OX1RJTUVPVVRfSEFORExFUl9OQU1FXTogb25UaW1lb3V0LFxufTtcblxuLyoqXG4gKiBUaGUgbWFpbiBydW50aW1lIGVudHJ5cG9pbnQgb2YgdGhlIGFzeW5jIGN1c3RvbSByZXNvdXJjZSBsYW1iZGEgZnVuY3Rpb24uXG4gKlxuICogQW55IGxpZmVjeWNsZSBldmVudCBjaGFuZ2VzIHRvIHRoZSBjdXN0b20gcmVzb3VyY2VzIHdpbGwgaW52b2tlIHRoaXMgaGFuZGxlciwgd2hpY2ggd2lsbCwgaW4gdHVybixcbiAqIGludGVyYWN0IHdpdGggdGhlIHVzZXItZGVmaW5lZCBgb25FdmVudGAgYW5kIGBpc0NvbXBsZXRlYCBoYW5kbGVycy5cbiAqXG4gKiBUaGlzIGZ1bmN0aW9uIHdpbGwgYWx3YXlzIHN1Y2NlZWQuIElmIGFuIGVycm9yIG9jY3VycywgaXQgaXMgbG9nZ2VkIGJ1dCBhbiBlcnJvciBpcyBub3QgdGhyb3duLlxuICpcbiAqIEBwYXJhbSBjZm5SZXF1ZXN0IFRoZSBjbG91ZGZvcm1hdGlvbiBjdXN0b20gcmVzb3VyY2UgZXZlbnQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG9uRXZlbnQoY2ZuUmVxdWVzdDogQVdTTGFtYmRhLkNsb3VkRm9ybWF0aW9uQ3VzdG9tUmVzb3VyY2VFdmVudCkge1xuICBjb25zdCBzYW5pdGl6ZWRSZXF1ZXN0ID0geyAuLi5jZm5SZXF1ZXN0LCBSZXNwb25zZVVSTDogJy4uLicgfSBhcyBjb25zdDtcbiAgbG9nKCdvbkV2ZW50SGFuZGxlcicsIHNhbml0aXplZFJlcXVlc3QpO1xuXG4gIGNmblJlcXVlc3QuUmVzb3VyY2VQcm9wZXJ0aWVzID0gY2ZuUmVxdWVzdC5SZXNvdXJjZVByb3BlcnRpZXMgfHwgeyB9O1xuXG4gIGNvbnN0IG9uRXZlbnRSZXN1bHQgPSBhd2FpdCBpbnZva2VVc2VyRnVuY3Rpb24oY29uc3RzLlVTRVJfT05fRVZFTlRfRlVOQ1RJT05fQVJOX0VOViwgc2FuaXRpemVkUmVxdWVzdCwgY2ZuUmVxdWVzdC5SZXNwb25zZVVSTCkgYXMgT25FdmVudFJlc3BvbnNlO1xuICBsb2coJ29uRXZlbnQgcmV0dXJuZWQ6Jywgb25FdmVudFJlc3VsdCk7XG5cbiAgLy8gbWVyZ2UgdGhlIHJlcXVlc3QgYW5kIHRoZSByZXN1bHQgZnJvbSBvbkV2ZW50IHRvIGZvcm0gdGhlIGNvbXBsZXRlIHJlc291cmNlIGV2ZW50XG4gIC8vIHRoaXMgYWxzbyBwZXJmb3JtcyB2YWxpZGF0aW9uLlxuICBjb25zdCByZXNvdXJjZUV2ZW50ID0gY3JlYXRlUmVzcG9uc2VFdmVudChjZm5SZXF1ZXN0LCBvbkV2ZW50UmVzdWx0KTtcbiAgbG9nKCdldmVudDonLCBvbkV2ZW50UmVzdWx0KTtcblxuICAvLyBkZXRlcm1pbmUgaWYgdGhpcyBpcyBhbiBhc3luYyBwcm92aWRlciBiYXNlZCBvbiB3aGV0aGVyIHdlIGhhdmUgYW4gaXNDb21wbGV0ZSBoYW5kbGVyIGRlZmluZWQuXG4gIC8vIGlmIGl0IGlzIG5vdCBkZWZpbmVkLCB0aGVuIHdlIGFyZSBiYXNpY2FsbHkgcmVhZHkgdG8gcmV0dXJuIGEgcG9zaXRpdmUgcmVzcG9uc2UuXG4gIGlmICghcHJvY2Vzcy5lbnZbY29uc3RzLlVTRVJfSVNfQ09NUExFVEVfRlVOQ1RJT05fQVJOX0VOVl0pIHtcbiAgICByZXR1cm4gY2ZuUmVzcG9uc2Uuc3VibWl0UmVzcG9uc2UoJ1NVQ0NFU1MnLCByZXNvdXJjZUV2ZW50LCB7IG5vRWNobzogcmVzb3VyY2VFdmVudC5Ob0VjaG8gfSk7XG4gIH1cblxuICAvLyBvaywgd2UgYXJlIG5vdCBjb21wbGV0ZSwgc28ga2ljayBvZmYgdGhlIHdhaXRlciB3b3JrZmxvd1xuICBjb25zdCB3YWl0ZXIgPSB7XG4gICAgc3RhdGVNYWNoaW5lQXJuOiBnZXRFbnYoY29uc3RzLldBSVRFUl9TVEFURV9NQUNISU5FX0FSTl9FTlYpLFxuICAgIG5hbWU6IHJlc291cmNlRXZlbnQuUmVxdWVzdElkLFxuICAgIGlucHV0OiBKU09OLnN0cmluZ2lmeShyZXNvdXJjZUV2ZW50KSxcbiAgfTtcblxuICBsb2coJ3N0YXJ0aW5nIHdhaXRlcicsIHtcbiAgICBzdGF0ZU1hY2hpbmVBcm46IGdldEVudihjb25zdHMuV0FJVEVSX1NUQVRFX01BQ0hJTkVfQVJOX0VOViksXG4gICAgbmFtZTogcmVzb3VyY2VFdmVudC5SZXF1ZXN0SWQsXG4gIH0pO1xuXG4gIC8vIGtpY2sgb2ZmIHdhaXRlciBzdGF0ZSBtYWNoaW5lXG4gIGF3YWl0IHN0YXJ0RXhlY3V0aW9uKHdhaXRlcik7XG59XG5cbi8vIGludm9rZWQgYSBmZXcgdGltZXMgdW50aWwgYGNvbXBsZXRlYCBpcyB0cnVlIG9yIHVudGlsIGl0IHRpbWVzIG91dC5cbmFzeW5jIGZ1bmN0aW9uIGlzQ29tcGxldGUoZXZlbnQ6IEFXU0NES0FzeW5jQ3VzdG9tUmVzb3VyY2UuSXNDb21wbGV0ZVJlcXVlc3QpIHtcbiAgY29uc3Qgc2FuaXRpemVkUmVxdWVzdCA9IHsgLi4uZXZlbnQsIFJlc3BvbnNlVVJMOiAnLi4uJyB9IGFzIGNvbnN0O1xuICBsb2coJ2lzQ29tcGxldGUnLCBzYW5pdGl6ZWRSZXF1ZXN0KTtcblxuICBjb25zdCBpc0NvbXBsZXRlUmVzdWx0ID0gYXdhaXQgaW52b2tlVXNlckZ1bmN0aW9uKGNvbnN0cy5VU0VSX0lTX0NPTVBMRVRFX0ZVTkNUSU9OX0FSTl9FTlYsIHNhbml0aXplZFJlcXVlc3QsIGV2ZW50LlJlc3BvbnNlVVJMKSBhcyBJc0NvbXBsZXRlUmVzcG9uc2U7XG4gIGxvZygndXNlciBpc0NvbXBsZXRlIHJldHVybmVkOicsIGlzQ29tcGxldGVSZXN1bHQpO1xuXG4gIC8vIGlmIHdlIGFyZSBub3QgY29tcGxldGUsIHJldHVybiBmYWxzZSwgYW5kIGRvbid0IHNlbmQgYSByZXNwb25zZSBiYWNrLlxuICBpZiAoIWlzQ29tcGxldGVSZXN1bHQuSXNDb21wbGV0ZSkge1xuICAgIGlmIChpc0NvbXBsZXRlUmVzdWx0LkRhdGEgJiYgT2JqZWN0LmtleXMoaXNDb21wbGV0ZVJlc3VsdC5EYXRhKS5sZW5ndGggPiAwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1wiRGF0YVwiIGlzIG5vdCBhbGxvd2VkIGlmIFwiSXNDb21wbGV0ZVwiIGlzIFwiRmFsc2VcIicpO1xuICAgIH1cblxuICAgIC8vIFRoaXMgbXVzdCBiZSB0aGUgZnVsbCBldmVudCwgaXQgd2lsbCBiZSBkZXNlcmlhbGl6ZWQgaW4gYG9uVGltZW91dGAgdG8gc2VuZCB0aGUgcmVzcG9uc2UgdG8gQ2xvdWRGb3JtYXRpb25cbiAgICB0aHJvdyBuZXcgY2ZuUmVzcG9uc2UuUmV0cnkoSlNPTi5zdHJpbmdpZnkoZXZlbnQpKTtcbiAgfVxuXG4gIGNvbnN0IHJlc3BvbnNlID0ge1xuICAgIC4uLmV2ZW50LFxuICAgIC4uLmlzQ29tcGxldGVSZXN1bHQsXG4gICAgRGF0YToge1xuICAgICAgLi4uZXZlbnQuRGF0YSxcbiAgICAgIC4uLmlzQ29tcGxldGVSZXN1bHQuRGF0YSxcbiAgICB9LFxuICB9O1xuXG4gIGF3YWl0IGNmblJlc3BvbnNlLnN1Ym1pdFJlc3BvbnNlKCdTVUNDRVNTJywgcmVzcG9uc2UsIHsgbm9FY2hvOiBldmVudC5Ob0VjaG8gfSk7XG59XG5cbi8vIGludm9rZWQgd2hlbiBjb21wbGV0aW9uIHJldHJpZXMgYXJlIGV4aGF1c2VkLlxuYXN5bmMgZnVuY3Rpb24gb25UaW1lb3V0KHRpbWVvdXRFdmVudDogYW55KSB7XG4gIGxvZygndGltZW91dEhhbmRsZXInLCB0aW1lb3V0RXZlbnQpO1xuXG4gIGNvbnN0IGlzQ29tcGxldGVSZXF1ZXN0ID0gSlNPTi5wYXJzZShKU09OLnBhcnNlKHRpbWVvdXRFdmVudC5DYXVzZSkuZXJyb3JNZXNzYWdlKSBhcyBBV1NDREtBc3luY0N1c3RvbVJlc291cmNlLklzQ29tcGxldGVSZXF1ZXN0O1xuICBhd2FpdCBjZm5SZXNwb25zZS5zdWJtaXRSZXNwb25zZSgnRkFJTEVEJywgaXNDb21wbGV0ZVJlcXVlc3QsIHtcbiAgICByZWFzb246ICdPcGVyYXRpb24gdGltZWQgb3V0JyxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGludm9rZVVzZXJGdW5jdGlvbjxBIGV4dGVuZHMgeyBSZXNwb25zZVVSTDogJy4uLicgfT4oZnVuY3Rpb25Bcm5FbnY6IHN0cmluZywgc2FuaXRpemVkUGF5bG9hZDogQSwgcmVzcG9uc2VVcmw6IHN0cmluZykge1xuICBjb25zdCBmdW5jdGlvbkFybiA9IGdldEVudihmdW5jdGlvbkFybkVudik7XG4gIGxvZyhgZXhlY3V0aW5nIHVzZXIgZnVuY3Rpb24gJHtmdW5jdGlvbkFybn0gd2l0aCBwYXlsb2FkYCwgc2FuaXRpemVkUGF5bG9hZCk7XG5cbiAgLy8gdHJhbnNpZW50IGVycm9ycyBzdWNoIGFzIHRpbWVvdXRzLCB0aHJvdHRsaW5nIGVycm9ycyAoNDI5KSwgYW5kIG90aGVyXG4gIC8vIGVycm9ycyB0aGF0IGFyZW4ndCBjYXVzZWQgYnkgYSBiYWQgcmVxdWVzdCAoNTAwIHNlcmllcykgYXJlIHJldHJpZWRcbiAgLy8gYXV0b21hdGljYWxseSBieSB0aGUgSmF2YVNjcmlwdCBTREsuXG4gIGNvbnN0IHJlc3AgPSBhd2FpdCBpbnZva2VGdW5jdGlvbih7XG4gICAgRnVuY3Rpb25OYW1lOiBmdW5jdGlvbkFybixcblxuICAgIC8vIENhbm5vdCBzdHJpcCAnUmVzcG9uc2VVUkwnIGhlcmUgYXMgdGhpcyB3b3VsZCBiZSBhIGJyZWFraW5nIGNoYW5nZSBldmVuIHRob3VnaCB0aGUgZG93bnN0cmVhbSBDUiBkb2Vzbid0IG5lZWQgaXRcbiAgICBQYXlsb2FkOiBKU09OLnN0cmluZ2lmeSh7IC4uLnNhbml0aXplZFBheWxvYWQsIFJlc3BvbnNlVVJMOiByZXNwb25zZVVybCB9KSxcbiAgfSk7XG5cbiAgbG9nKCd1c2VyIGZ1bmN0aW9uIHJlc3BvbnNlOicsIHJlc3AsIHR5cGVvZihyZXNwKSk7XG5cbiAgLy8gUGFyc2VKc29uUGF5bG9hZCBpcyB2ZXJ5IGRlZmVuc2l2ZS4gSXQgc2hvdWxkIG5vdCBiZSBwb3NzaWJsZSBmb3IgYFBheWxvYWRgXG4gIC8vIHRvIGJlIGFueXRoaW5nIG90aGVyIHRoYW4gYSBKU09OIGVuY29kZWQgc3RyaW5nIChvciBpbnRhcnJheSkuIFNvbWV0aGluZyB3ZWlyZCBpc1xuICAvLyBnb2luZyBvbiBpZiB0aGF0IGhhcHBlbnMuIFN0aWxsLCB3ZSBzaG91bGQgZG8gb3VyIGJlc3QgdG8gc3Vydml2ZSBpdC5cbiAgY29uc3QganNvblBheWxvYWQgPSBwYXJzZUpzb25QYXlsb2FkKHJlc3AuUGF5bG9hZCk7XG4gIGlmIChyZXNwLkZ1bmN0aW9uRXJyb3IpIHtcbiAgICBsb2coJ3VzZXIgZnVuY3Rpb24gdGhyZXcgYW4gZXJyb3I6JywgcmVzcC5GdW5jdGlvbkVycm9yKTtcblxuICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9IGpzb25QYXlsb2FkLmVycm9yTWVzc2FnZSB8fCAnZXJyb3InO1xuXG4gICAgLy8gcGFyc2UgZnVuY3Rpb24gbmFtZSBmcm9tIGFyblxuICAgIC8vIGFybjoke1BhcnRpdGlvbn06bGFtYmRhOiR7UmVnaW9ufToke0FjY291bnR9OmZ1bmN0aW9uOiR7RnVuY3Rpb25OYW1lfVxuICAgIGNvbnN0IGFybiA9IGZ1bmN0aW9uQXJuLnNwbGl0KCc6Jyk7XG4gICAgY29uc3QgZnVuY3Rpb25OYW1lID0gYXJuW2Fybi5sZW5ndGggLSAxXTtcblxuICAgIC8vIGFwcGVuZCBhIHJlZmVyZW5jZSB0byB0aGUgbG9nIGdyb3VwLlxuICAgIGNvbnN0IG1lc3NhZ2UgPSBbXG4gICAgICBlcnJvck1lc3NhZ2UsXG4gICAgICAnJyxcbiAgICAgIGBMb2dzOiAvYXdzL2xhbWJkYS8ke2Z1bmN0aW9uTmFtZX1gLCAvLyBjbG91ZHdhdGNoIGxvZyBncm91cFxuICAgICAgJycsXG4gICAgXS5qb2luKCdcXG4nKTtcblxuICAgIGNvbnN0IGUgPSBuZXcgRXJyb3IobWVzc2FnZSk7XG5cbiAgICAvLyB0aGUgb3V0cHV0IHRoYXQgZ29lcyB0byBDRk4gaXMgd2hhdCdzIGluIGBzdGFja2AsIG5vdCB0aGUgZXJyb3IgbWVzc2FnZS5cbiAgICAvLyBpZiB3ZSBoYXZlIGEgcmVtb3RlIHRyYWNlLCBjb25zdHJ1Y3QgYSBuaWNlIG1lc3NhZ2Ugd2l0aCBsb2cgZ3JvdXAgaW5mb3JtYXRpb25cbiAgICBpZiAoanNvblBheWxvYWQudHJhY2UpIHtcbiAgICAgIC8vIHNraXAgZmlyc3QgdHJhY2UgbGluZSBiZWNhdXNlIGl0J3MgdGhlIG1lc3NhZ2VcbiAgICAgIGUuc3RhY2sgPSBbbWVzc2FnZSwgLi4uanNvblBheWxvYWQudHJhY2Uuc2xpY2UoMSldLmpvaW4oJ1xcbicpO1xuICAgIH1cblxuICAgIHRocm93IGU7XG4gIH1cblxuICByZXR1cm4ganNvblBheWxvYWQ7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVJlc3BvbnNlRXZlbnQoY2ZuUmVxdWVzdDogQVdTTGFtYmRhLkNsb3VkRm9ybWF0aW9uQ3VzdG9tUmVzb3VyY2VFdmVudCwgb25FdmVudFJlc3VsdDogT25FdmVudFJlc3BvbnNlKTogQVdTQ0RLQXN5bmNDdXN0b21SZXNvdXJjZS5Jc0NvbXBsZXRlUmVxdWVzdCB7XG4gIC8vXG4gIC8vIHZhbGlkYXRlIHRoYXQgb25FdmVudFJlc3VsdCBhbHdheXMgaW5jbHVkZXMgYSBQaHlzaWNhbFJlc291cmNlSWRcblxuICBvbkV2ZW50UmVzdWx0ID0gb25FdmVudFJlc3VsdCB8fCB7IH07XG5cbiAgLy8gaWYgcGh5c2ljYWwgSUQgaXMgbm90IHJldHVybmVkLCB3ZSBoYXZlIHNvbWUgZGVmYXVsdHMgZm9yIHlvdSBiYXNlZFxuICAvLyBvbiB0aGUgcmVxdWVzdCB0eXBlLlxuICBjb25zdCBwaHlzaWNhbFJlc291cmNlSWQgPSBvbkV2ZW50UmVzdWx0LlBoeXNpY2FsUmVzb3VyY2VJZCB8fCBkZWZhdWx0UGh5c2ljYWxSZXNvdXJjZUlkKGNmblJlcXVlc3QpO1xuXG4gIC8vIGlmIHdlIGFyZSBpbiBERUxFVEUgYW5kIHBoeXNpY2FsIElEIHdhcyBjaGFuZ2VkLCBpdCdzIGFuIGVycm9yLlxuICBpZiAoY2ZuUmVxdWVzdC5SZXF1ZXN0VHlwZSA9PT0gJ0RlbGV0ZScgJiYgcGh5c2ljYWxSZXNvdXJjZUlkICE9PSBjZm5SZXF1ZXN0LlBoeXNpY2FsUmVzb3VyY2VJZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgREVMRVRFOiBjYW5ub3QgY2hhbmdlIHRoZSBwaHlzaWNhbCByZXNvdXJjZSBJRCBmcm9tIFwiJHtjZm5SZXF1ZXN0LlBoeXNpY2FsUmVzb3VyY2VJZH1cIiB0byBcIiR7b25FdmVudFJlc3VsdC5QaHlzaWNhbFJlc291cmNlSWR9XCIgZHVyaW5nIGRlbGV0aW9uYCk7XG4gIH1cblxuICAvLyBpZiB3ZSBhcmUgaW4gVVBEQVRFIGFuZCBwaHlzaWNhbCBJRCB3YXMgY2hhbmdlZCwgaXQncyBhIHJlcGxhY2VtZW50IChqdXN0IGxvZylcbiAgaWYgKGNmblJlcXVlc3QuUmVxdWVzdFR5cGUgPT09ICdVcGRhdGUnICYmIHBoeXNpY2FsUmVzb3VyY2VJZCAhPT0gY2ZuUmVxdWVzdC5QaHlzaWNhbFJlc291cmNlSWQpIHtcbiAgICBsb2coYFVQREFURTogY2hhbmdpbmcgcGh5c2ljYWwgcmVzb3VyY2UgSUQgZnJvbSBcIiR7Y2ZuUmVxdWVzdC5QaHlzaWNhbFJlc291cmNlSWR9XCIgdG8gXCIke29uRXZlbnRSZXN1bHQuUGh5c2ljYWxSZXNvdXJjZUlkfVwiYCk7XG4gIH1cblxuICAvLyBtZXJnZSByZXF1ZXN0IGV2ZW50IGFuZCByZXN1bHQgZXZlbnQgKHJlc3VsdCBwcmV2YWlscykuXG4gIHJldHVybiB7XG4gICAgLi4uY2ZuUmVxdWVzdCxcbiAgICAuLi5vbkV2ZW50UmVzdWx0LFxuICAgIFBoeXNpY2FsUmVzb3VyY2VJZDogcGh5c2ljYWxSZXNvdXJjZUlkLFxuICB9O1xufVxuXG4vKipcbiAqIENhbGN1bGF0ZXMgdGhlIGRlZmF1bHQgcGh5c2ljYWwgcmVzb3VyY2UgSUQgYmFzZWQgaW4gY2FzZSB1c2VyIGhhbmRsZXIgZGlkXG4gKiBub3QgcmV0dXJuIGEgUGh5c2ljYWxSZXNvdXJjZUlkLlxuICpcbiAqIEZvciBcIkNSRUFURVwiLCBpdCB1c2VzIHRoZSBSZXF1ZXN0SWQuXG4gKiBGb3IgXCJVUERBVEVcIiBhbmQgXCJERUxFVEVcIiBhbmQgcmV0dXJucyB0aGUgY3VycmVudCBQaHlzaWNhbFJlc291cmNlSWQgKHRoZSBvbmUgcHJvdmlkZWQgaW4gYGV2ZW50YCkuXG4gKi9cbmZ1bmN0aW9uIGRlZmF1bHRQaHlzaWNhbFJlc291cmNlSWQocmVxOiBBV1NMYW1iZGEuQ2xvdWRGb3JtYXRpb25DdXN0b21SZXNvdXJjZUV2ZW50KTogc3RyaW5nIHtcbiAgc3dpdGNoIChyZXEuUmVxdWVzdFR5cGUpIHtcbiAgICBjYXNlICdDcmVhdGUnOlxuICAgICAgcmV0dXJuIHJlcS5SZXF1ZXN0SWQ7XG5cbiAgICBjYXNlICdVcGRhdGUnOlxuICAgIGNhc2UgJ0RlbGV0ZSc6XG4gICAgICByZXR1cm4gcmVxLlBoeXNpY2FsUmVzb3VyY2VJZDtcblxuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgXCJSZXF1ZXN0VHlwZVwiIGluIHJlcXVlc3QgXCIke0pTT04uc3RyaW5naWZ5KHJlcSl9XCJgKTtcbiAgfVxufVxuIl19