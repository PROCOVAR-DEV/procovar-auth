"use client";

import { useState } from "react";
import { Input, Button } from "@heroui/react";
import { useTranslations } from "next-intl";
import { Icons } from "@/components/icons/iconify";
import { useFullUser } from "@/components/full-user-provider";
import { authClient } from "@/lib/auth-client";
import { SectionCard, StatusMsg, outlinedButtonClass } from "./section-card";

export function SecuritySection() {
    const t = useTranslations();
    const { user } = useFullUser();
    const hasPassword = user?.accounts?.some((a) => a.providerId === "credential") ?? false;

    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [savingPassword, setSavingPassword] = useState(false);
    const [passwordMsg, setPasswordMsg] = useState("");

    async function handleChangePassword() {
        if (newPassword !== confirmPassword) {
            setPasswordMsg(t("myProfile.security.passwordsMismatch"));
            return;
        }
        if (newPassword.length < 8) {
            setPasswordMsg(t("myProfile.security.passwordTooShort"));
            return;
        }
        setSavingPassword(true);
        setPasswordMsg("");
        const { error } = await authClient.changePassword({
            currentPassword,
            newPassword,
            // Lo estándar: quien cambia la contraseña porque sospecha de su cuenta no deja viva la sesión ajena.
            revokeOtherSessions: true,
        });
        if (error) {
            setPasswordMsg(t("myProfile.security.wrongCurrentPassword"));
        } else {
            setPasswordMsg(t("myProfile.security.passwordUpdated"));
            setCurrentPassword("");
            setNewPassword("");
            setConfirmPassword("");
        }
        setSavingPassword(false);
    }

    return (
        <SectionCard
            icon={<Icons.shieldKey className="size-5 text-blue-600 dark:text-blue-400" />}
            title={t("myProfile.security.title")}
        >
            <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
                    {t("myProfile.security.linkedAccounts")}
                </p>
                <div className="flex flex-wrap gap-2">
                    {user?.accounts?.map((acc) => (
                        <span
                            key={acc.id}
                            className="inline-flex items-center gap-1.5 rounded-sm border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 dark:border-slate-700 dark:bg-slate-900 dark:text-gray-300"
                        >
                            <Icons.link className="size-3" />
                            {acc.providerId === "credential" ? t("myProfile.security.emailPassword") : acc.providerId}
                        </span>
                    ))}
                </div>
            </div>

            {hasPassword && (
                <div className="space-y-3 border-t border-gray-100 pt-3 dark:border-slate-700">
                    <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                        {t("myProfile.security.changePassword")}
                    </p>
                    <Input
                        label={t("myProfile.security.currentPassword")}
                        labelPlacement="outside"
                        variant="bordered"
                        type="password"
                        size="md"
                        value={currentPassword}
                        onValueChange={setCurrentPassword}
                        classNames={{ inputWrapper: "bg-white dark:bg-slate-900" }}
                    />
                    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                        <Input
                            label={t("myProfile.security.newPassword")}
                            labelPlacement="outside"
                            variant="bordered"
                            type="password"
                            size="md"
                            value={newPassword}
                            onValueChange={setNewPassword}
                            description={t("myProfile.security.minChars")}
                            classNames={{ inputWrapper: "bg-white dark:bg-slate-900" }}
                        />
                        <Input
                            label={t("myProfile.security.confirmPassword")}
                            labelPlacement="outside"
                            variant="bordered"
                            type="password"
                            size="md"
                            value={confirmPassword}
                            onValueChange={setConfirmPassword}
                            classNames={{ inputWrapper: "bg-white dark:bg-slate-900" }}
                        />
                    </div>
                    <div className="flex items-center gap-3">
                        <Button
                            size="sm"
                            variant="bordered"
                            className={outlinedButtonClass}
                            isLoading={savingPassword}
                            onPress={handleChangePassword}
                        >
                            {t("myProfile.security.updatePassword")}
                        </Button>
                        <StatusMsg msg={passwordMsg} />
                    </div>
                </div>
            )}
        </SectionCard>
    );
}
