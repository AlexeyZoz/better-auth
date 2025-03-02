import { z } from "zod";
import { createAuthEndpoint } from "../../api/call";
import type { BetterAuthPlugin, InferOptionSchema, AuthPluginSchema } from "../../types/plugins";
import { APIError } from "better-call";
import { mergeSchema } from "../../db/schema";
import { generateRandomString } from "../../crypto/random";
import { getSessionFromCtx } from "../../api";
import { getDate } from "../../utils/date";
import { setSessionCookie } from "../../cookies";
import { BASE_ERROR_CODES } from "../../error/codes";
import type { User } from "../../types";

export interface UserWithPhoneNumber extends User {
	phoneNumber: string;
	phoneNumberVerified: boolean;
}

export type CustomSendOTPOptions = {
	generate?: boolean;
	reason?: string;
} | void;

function generateOTP(size: number) {
	return generateRandomString(size, "0-9");
}

export interface PhoneNumberOptions {
	/**
	 * Length of the OTP code
	 * @default 6
	 */
	otpLength?: number;
	/**
	 * Send OTP code to the user
	 *
	 * @param phoneNumber
	 * @param code
	 * @returns
	 */
	sendOTP: (
		data: { phoneNumber: string; code: string },
		request?: Request
	) => CustomSendOTPOptions | Promise<CustomSendOTPOptions>;
	/**
	 * a callback to send otp on user requesting to reset their password
	 *
	 * @param data - contains phone number and code
	 * @param request - the request object
	 * @returns
	 */
	sendForgetPasswordOTP?: (data: { phoneNumber: string; code: string }, request?: Request) => Promise<void> | void;
	/**
	 * Expiry time of the OTP code in seconds
	 * @default 300
	 */
	expiresIn?: number;
	/**
	 * Function to validate phone number
	 *
	 * by default any string is accepted
	 */
	phoneNumberValidator?: (phoneNumber: string) => boolean | Promise<boolean>;
	/**
	 * Callback when phone number is verified
	 */
	callbackOnVerification?: (
		data: {
			phoneNumber: string;
			user: UserWithPhoneNumber;
		},
		request?: Request
	) => void | Promise<void>;
	/**
	 * Sign up user after phone number verification
	 *
	 * the user will be signed up with the temporary email
	 * and the phone number will be updated after verification
	 */
	signUpOnVerification?: {
		/**
		 * When a user signs up, a temporary email will be need to be created
		 * to sign up the user. This function should return a temporary email
		 * for the user given the phone number
		 *
		 * @param phoneNumber
		 * @returns string (temporary email)
		 */
		getTempEmail: (phoneNumber: string) => string;
		/**
		 * When a user signs up, a temporary name will be need to be created
		 * to sign up the user. This function should return a temporary name
		 * for the user given the phone number
		 *
		 * @param phoneNumber
		 * @returns string (temporary name)
		 *
		 * @default phoneNumber - the phone number will be used as the name
		 */
		getTempName?: (phoneNumber: string) => string;
	};
	/**
	 * Custom schema for the admin plugin
	 */
	schema?: InferOptionSchema<typeof schema>;
}

export const phoneNumber = (options?: PhoneNumberOptions) => {
	const opts = {
		expiresIn: options?.expiresIn || 300,
		otpLength: options?.otpLength || 6,
		...options,
		phoneNumber: "phoneNumber",
		phoneNumberVerified: "phoneNumberVerified",
		code: "code",
		createdAt: "createdAt"
	};

	const ERROR_CODES = {
		INVALID_PHONE_NUMBER: "Invalid phone number",
		INVALID_PHONE_NUMBER_OR_PASSWORD: "Invalid phone number or password",
		UNEXPECTED_ERROR: "Unexpected error",
		OTP_NOT_FOUND: "OTP not found",
		OTP_EXPIRED: "OTP expired",
		INVALID_OTP: "Invalid OTP",
		USER_CHOICE: "OTP generation set to false"
	} as const;
	return {
		id: "phone-number",
		endpoints: {
			signInPhoneNumber: createAuthEndpoint(
				"/sign-in/phone-number",
				{
					method: "POST",
					body: z.object({
						phoneNumber: z.string({
							description: "Phone number to sign in"
						}),
						password: z.string({
							description: "Password to use for sign in"
						}),
						rememberMe: z
							.boolean({
								description: "Remember the session"
							})
							.optional()
					}),
					metadata: {
						openapi: {
							summary: "Sign in with phone number",
							description: "Use this endpoint to sign in with phone number",
							responses: {
								200: {
									description: "Success",
									content: {
										"application/json": {
											schema: {
												type: "object",
												properties: {
													user: {
														$ref: "#/components/schemas/User"
													},
													session: {
														$ref: "#/components/schemas/Session"
													}
												}
											}
										}
									}
								},
								400: {
									description: "Invalid phone number or password"
								}
							}
						}
					}
				},
				async (ctx) => {
					const { password, phoneNumber } = ctx.body;

					if (opts.phoneNumberValidator) {
						const isValidNumber = await opts.phoneNumberValidator(ctx.body.phoneNumber);
						if (!isValidNumber) {
							throw new APIError("BAD_REQUEST", {
								message: ERROR_CODES.INVALID_PHONE_NUMBER
							});
						}
					}

					const user = await ctx.context.adapter.findOne<UserWithPhoneNumber>({
						model: "user",
						where: [
							{
								field: "phoneNumber",
								value: phoneNumber
							}
						]
					});
					if (!user) {
						throw new APIError("UNAUTHORIZED", {
							message: ERROR_CODES.INVALID_PHONE_NUMBER_OR_PASSWORD
						});
					}
					const accounts = await ctx.context.internalAdapter.findAccountByUserId(user.id);
					const credentialAccount = accounts.find((a) => a.providerId === "credential");
					if (!credentialAccount) {
						ctx.context.logger.error("Credential account not found", {
							phoneNumber
						});
						throw new APIError("UNAUTHORIZED", {
							message: ERROR_CODES.INVALID_PHONE_NUMBER_OR_PASSWORD
						});
					}
					const currentPassword = credentialAccount?.password;
					if (!currentPassword) {
						ctx.context.logger.error("Password not found", { phoneNumber });
						throw new APIError("UNAUTHORIZED", {
							message: ERROR_CODES.UNEXPECTED_ERROR
						});
					}
					const validPassword = await ctx.context.password.verify({
						hash: currentPassword,
						password
					});
					if (!validPassword) {
						ctx.context.logger.error("Invalid password");
						throw new APIError("UNAUTHORIZED", {
							message: ERROR_CODES.INVALID_PHONE_NUMBER_OR_PASSWORD
						});
					}
					const session = await ctx.context.internalAdapter.createSession(
						user.id,
						ctx.headers,
						ctx.body.rememberMe === false
					);
					if (!session) {
						ctx.context.logger.error("Failed to create session");
						throw new APIError("UNAUTHORIZED", {
							message: BASE_ERROR_CODES.FAILED_TO_CREATE_SESSION
						});
					}

					await setSessionCookie(
						ctx,
						{
							session,
							user: user
						},
						ctx.body.rememberMe === false
					);
					return ctx.json({
						token: session.token,
						user: {
							id: user.id,
							email: user.email,
							emailVerified: user.emailVerified,
							name: user.name,
							image: user.image,
							phoneNumber: user.phoneNumber,
							phoneNumberVerified: user.phoneNumberVerified,
							createdAt: user.createdAt,
							updatedAt: user.updatedAt
						} as UserWithPhoneNumber
					});
				}
			),
			sendPhoneNumberOTP: createAuthEndpoint(
				"/phone-number/send-otp",
				{
					method: "POST",
					body: z.object({
						phoneNumber: z.string({
							description: "Phone number to send OTP"
						})
					}),
					metadata: {
						openapi: {
							summary: "Send OTP to phone number",
							description: "Use this endpoint to send OTP to phone number",
							responses: {
								200: {
									description: "Success",
									content: {
										"application/json": {
											schema: {
												type: "object",
												properties: {
													message: {
														type: "string"
													}
												}
											}
										}
									}
								}
							}
						}
					}
				},
				async (ctx) => {
					if (!options?.sendOTP) {
						ctx.context.logger.warn("sendOTP not implemented");
						throw new APIError("NOT_IMPLEMENTED", {
							message: "sendOTP not implemented"
						});
					}

					if (opts.phoneNumberValidator) {
						const isValidNumber = await opts.phoneNumberValidator(ctx.body.phoneNumber);
						if (!isValidNumber) {
							throw new APIError("BAD_REQUEST", {
								message: ERROR_CODES.INVALID_PHONE_NUMBER
							});
						}
					}

					const code = generateOTP(opts.otpLength);

					const sendOTPRes: CustomSendOTPOptions = await options.sendOTP(
						{
							phoneNumber: ctx.body.phoneNumber,
							code
						},
						ctx.request
					);

					if (sendOTPRes?.generate) {
						throw new APIError("UNAUTHORIZED", {
							message: sendOTPRes?.reason ?? ERROR_CODES.USER_CHOICE
						});
					}

					await ctx.context.internalAdapter.createVerificationValue({
						value: code,
						identifier: ctx.body.phoneNumber,
						expiresAt: getDate(opts.expiresIn, "sec")
					});

					return ctx.json(
						{ code },
						{
							body: {
								message: "Code sent"
							}
						}
					);
				}
			),
			verifyPhoneNumber: createAuthEndpoint(
				"/phone-number/verify",
				{
					method: "POST",
					body: z.object({
						/**
						 * Phone number
						 */
						phoneNumber: z.string({
							description: "Phone number to verify"
						}),
						/**
						 * OTP code
						 */
						code: z.string({
							description: "OTP code"
						}),
						/**
						 * Disable session creation after verification
						 * @default false
						 */
						disableSession: z
							.boolean({
								description: "Disable session creation after verification"
							})
							.optional(),
						/**
						 * This checks if there is a session already
						 * and updates the phone number with the provided
						 * phone number
						 */
						updatePhoneNumber: z
							.boolean({
								description: "Check if there is a session and update the phone number"
							})
							.optional()
					}),
					metadata: {
						openapi: {
							summary: "Verify phone number",
							description: "Use this endpoint to verify phone number",
							responses: {
								200: {
									description: "Success",
									content: {
										"application/json": {
											schema: {
												type: "object",
												properties: {
													user: {
														$ref: "#/components/schemas/User"
													},
													session: {
														$ref: "#/components/schemas/Session"
													}
												}
											}
										}
									}
								},
								400: {
									description: "Invalid OTP"
								}
							}
						}
					}
				},
				async (ctx) => {
					const otp = await ctx.context.internalAdapter.findVerificationValue(ctx.body.phoneNumber);

					if (!otp || otp.expiresAt < new Date()) {
						if (otp && otp.expiresAt < new Date()) {
							throw new APIError("BAD_REQUEST", {
								message: "OTP expired"
							});
						}
						throw new APIError("BAD_REQUEST", {
							message: ERROR_CODES.OTP_NOT_FOUND
						});
					}
					if (otp.value !== ctx.body.code) {
						throw new APIError("BAD_REQUEST", {
							message: "Invalid OTP"
						});
					}

					await ctx.context.internalAdapter.deleteVerificationValue(otp.id);

					if (ctx.body.updatePhoneNumber) {
						const session = await getSessionFromCtx(ctx);
						if (!session) {
							throw new APIError("UNAUTHORIZED", {
								message: BASE_ERROR_CODES.USER_NOT_FOUND
							});
						}
						let user = await ctx.context.internalAdapter.updateUser(
							session.user.id,
							{
								[opts.phoneNumber]: ctx.body.phoneNumber,
								[opts.phoneNumberVerified]: true
							},
							ctx
						);
						return ctx.json({
							status: true,
							token: session.session.token,
							user: {
								id: user.id,
								email: user.email,
								emailVerified: user.emailVerified,
								name: user.name,
								image: user.image,
								phoneNumber: user.phoneNumber,
								phoneNumberVerified: user.phoneNumberVerified,
								createdAt: user.createdAt,
								updatedAt: user.updatedAt
							} as UserWithPhoneNumber
						});
					}

					let user = await ctx.context.adapter.findOne<UserWithPhoneNumber>({
						model: "user",
						where: [
							{
								value: ctx.body.phoneNumber,
								field: opts.phoneNumber
							}
						]
					});
					if (!user) {
						if (options?.signUpOnVerification) {
							user = await ctx.context.internalAdapter.createUser(
								{
									email: options.signUpOnVerification.getTempEmail(ctx.body.phoneNumber),
									name: options.signUpOnVerification.getTempName
										? options.signUpOnVerification.getTempName(ctx.body.phoneNumber)
										: ctx.body.phoneNumber,
									[opts.phoneNumber]: ctx.body.phoneNumber,
									[opts.phoneNumberVerified]: true
								},
								ctx
							);
							if (!user) {
								throw new APIError("INTERNAL_SERVER_ERROR", {
									message: BASE_ERROR_CODES.FAILED_TO_CREATE_USER
								});
							}
						}
					} else {
						user = await ctx.context.internalAdapter.updateUser(
							user.id,
							{
								[opts.phoneNumberVerified]: true
							},
							ctx
						);
					}

					if (!user) {
						return ctx.json(null);
					}

					await options?.callbackOnVerification?.(
						{
							phoneNumber: ctx.body.phoneNumber,
							user
						},
						ctx.request
					);

					if (!user) {
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: BASE_ERROR_CODES.FAILED_TO_UPDATE_USER
						});
					}

					if (!ctx.body.disableSession) {
						const session = await ctx.context.internalAdapter.createSession(user.id, ctx.request);
						if (!session) {
							throw new APIError("INTERNAL_SERVER_ERROR", {
								message: BASE_ERROR_CODES.FAILED_TO_CREATE_SESSION
							});
						}
						await setSessionCookie(ctx, {
							session,
							user
						});
						return ctx.json({
							status: true,
							token: session.token,
							user: {
								id: user.id,
								email: user.email,
								emailVerified: user.emailVerified,
								name: user.name,
								image: user.image,
								phoneNumber: user.phoneNumber,
								phoneNumberVerified: user.phoneNumberVerified,
								createdAt: user.createdAt,
								updatedAt: user.updatedAt
							} as UserWithPhoneNumber
						});
					}

					return ctx.json({
						status: true,
						token: null,
						user: {
							id: user.id,
							email: user.email,
							emailVerified: user.emailVerified,
							name: user.name,
							image: user.image,
							phoneNumber: user.phoneNumber,
							phoneNumberVerified: user.phoneNumberVerified,
							createdAt: user.createdAt,
							updatedAt: user.updatedAt
						} as UserWithPhoneNumber
					});
				}
			),
			forgetPasswordPhoneNumber: createAuthEndpoint(
				"/phone-number/forget-password",
				{
					method: "POST",
					body: z.object({
						phoneNumber: z.string()
					})
				},
				async (ctx) => {
					const user = await ctx.context.adapter.findOne<UserWithPhoneNumber>({
						model: "user",
						where: [
							{
								value: ctx.body.phoneNumber,
								field: opts.phoneNumber
							}
						]
					});
					if (!user) {
						throw new APIError("BAD_REQUEST", {
							message: "phone number isn't registered"
						});
					}
					const code = generateOTP(opts.otpLength);
					await ctx.context.internalAdapter.createVerificationValue({
						value: code,
						identifier: `${ctx.body.phoneNumber}-forget-password`,
						expiresAt: getDate(opts.expiresIn, "sec")
					});
					await options?.sendForgetPasswordOTP?.(
						{
							phoneNumber: ctx.body.phoneNumber,
							code
						},
						ctx.request
					);
					return ctx.json({
						status: true
					});
				}
			),
			resetPasswordPhoneNumber: createAuthEndpoint(
				"/phone-number/reset-password",
				{
					method: "POST",
					body: z.object({
						otp: z.string(),
						phoneNumber: z.string(),
						newPassword: z.string()
					})
				},
				async (ctx) => {
					const verification = await ctx.context.internalAdapter.findVerificationValue(
						`${ctx.body.phoneNumber}-forget-password`
					);
					if (!verification) {
						throw new APIError("BAD_REQUEST", {
							message: ERROR_CODES.OTP_NOT_FOUND
						});
					}
					if (verification.expiresAt < new Date()) {
						throw new APIError("BAD_REQUEST", {
							message: ERROR_CODES.OTP_EXPIRED
						});
					}
					if (verification.value !== ctx.body.otp) {
						throw new APIError("BAD_REQUEST", {
							message: ERROR_CODES.INVALID_OTP
						});
					}
					const user = await ctx.context.adapter.findOne<User>({
						model: "user",
						where: [
							{
								field: "phoneNumber",
								value: ctx.body.phoneNumber
							}
						]
					});
					if (!user) {
						throw new APIError("BAD_REQUEST", {
							message: ERROR_CODES.UNEXPECTED_ERROR
						});
					}
					const hashedPassword = await ctx.context.password.hash(ctx.body.newPassword);
					await ctx.context.internalAdapter.updatePassword(user.id, hashedPassword);
					return ctx.json({
						status: true
					});
				}
			)
		},
		schema: mergeSchema(schema, options?.schema),
		$ERROR_CODES: ERROR_CODES
	} satisfies BetterAuthPlugin;
};

const schema = {
	user: {
		fields: {
			phoneNumber: {
				type: "string",
				required: false,
				unique: true,
				sortable: true,
				returned: true
			},
			phoneNumberVerified: {
				type: "boolean",
				required: false,
				returned: true,
				input: false
			}
		}
	}
} satisfies AuthPluginSchema;
