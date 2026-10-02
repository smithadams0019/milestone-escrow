// The installed aws CLI predates `add-permission --invoked-via-function-url`, so this one permission goes through the SDK.
import { LambdaClient, AddPermissionCommand } from '../backend/node_modules/@aws-sdk/client-lambda/dist-cjs/index.js';
const c = new LambdaClient({ region: 'us-east-1' });
try {
  await c.send(new AddPermissionCommand({ FunctionName: process.argv[2], StatementId: 'url-invoke', Action: 'lambda:InvokeFunction', Principal: '*', InvokedViaFunctionUrl: true }));
  console.log('added lambda:InvokeFunction for Function URL callers');
} catch (e) { if (e.name === 'ResourceConflictException') console.log('permission already present'); else throw e; }
