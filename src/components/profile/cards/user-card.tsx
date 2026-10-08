"use client";

import { Card, CardBody, Avatar, Button } from "@heroui/react";
import { Icons } from "@/components/icons/iconify";
import Link from "next/link";
import { useTranslations } from "next-intl";

interface User {
    id: string;
    name: string;
    email: string;
    image?: string | null;
    emailVerified: boolean;
    isSystemAdmin?: boolean;
    createdAt: Date;
}

export function UserCard({ user, userInitial }: { user: User; userInitial: string }) {
    const t = useTranslations();
    return (
        <Card className="bg-white dark:bg-slate-900 shadow-lg shadow-gray-200/50 dark:shadow-none rounded-sm overflow-hidden">
            <CardBody className="p-0">
                <div className="flex items-center gap-4 md:gap-6 p-4 md:p-6">
                    <div className="shrink-0">
                        <Avatar
                            src={user.image || undefined}
                            name={userInitial}
                            className="w-16 h-16 md:w-20 md:h-20 text-xl md:text-2xl border-4 border-blue-100 dark:border-slate-700 shadow-md"
                            color="primary"
                            imgProps={{ referrerPolicy: "no-referrer" }}
                        />
                    </div>

                    <div className="flex-1 min-w-0">
                        <h2 className="text-xl md:text-2xl font-bold text-black dark:text-white truncate">{user.name}</h2>
                        <p className="text-sm text-gray-500 dark:text-gray-400 truncate">{user.email}</p>
                        <div className="mt-1.5">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-xs font-medium ${
                                user.emailVerified
                                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                                    : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                            }`}>
                                {user.emailVerified ? (
                                    <span className="flex gap-1.5 items-center">
                                        <Icons.checkCircle className="w-3 h-3" />{t('profile.emailVerified')}
                                    </span>
                                ) : (
                                    <span className="flex gap-1.5 items-center">
                                        <Icons.info className="w-3 h-3" />{t('profile.emailNotVerified')}
                                    </span>
                                )}
                            </span>
                        </div>
                    </div>

                    <Button
                        as={Link}
                        href="/profile#configurar-perfil"
                        variant="bordered"
                        className="shrink-0 font-medium hidden sm:flex border-pv-azul/85 text-pv-azul bg-transparent hover:bg-pv-azul/8"
                        startContent={<Icons.userCircle className="size-4" />}
                    >
                        {t('nav.settings')}
                    </Button>
                    <Button
                        as={Link}
                        href="/profile#configurar-perfil"
                        variant="bordered"
                        isIconOnly
                        className="shrink-0 sm:hidden border-pv-azul/85 text-pv-azul bg-transparent hover:bg-pv-azul/8"
                    >
                        <Icons.userCircle className="size-4" />
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}
