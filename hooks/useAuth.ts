'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { User } from '@supabase/supabase-js';

interface DbUser {
    id: string;
    email: string;
    provider: string;
    analysis_count: number;
    is_paid_user: boolean;
    is_unlimited: boolean;
    created_at: string;
    updated_at: string;
}

export function useAuth() {
    const [user, setUser] = useState<User | null>(null);
    const [dbUser, setDbUser] = useState<DbUser | null>(null);
    const [loading, setLoading] = useState(true);
    const supabase = useMemo(() => createClient(), []);

    const fetchDbUser = useCallback(async () => {
        try {
            const response = await fetch('/api/user/me');
            if (response.ok) {
                const data = await response.json();
                setDbUser(data.user);
            } else {
                setDbUser(null);
            }
        } catch (error) {
            console.error('Failed to fetch user data:', error);
            setDbUser(null);
        }
    }, []);

    useEffect(() => {
        // 현재 세션 확인
        const getUser = async () => {
            const { data: { user } } = await supabase.auth.getUser();
            setUser(user);
            if (user) {
                await fetchDbUser();
            }
            setLoading(false);
        };

        getUser();

        // 인증 상태 변경 구독
        const { data: { subscription } } = supabase.auth.onAuthStateChange(
            async (_event, session) => {
                setUser(session?.user ?? null);
                if (session?.user) {
                    await fetchDbUser();
                } else {
                    setDbUser(null);
                }
                setLoading(false);
            }
        );

        return () => {
            subscription.unsubscribe();
        };
    }, [supabase.auth, fetchDbUser]);

    const signInWithKakao = async (redirectTo?: string) => {
        const { error } = await supabase.auth.signInWithOAuth({
            provider: 'kakao',
            options: {
                redirectTo: `${window.location.origin}/auth/callback${redirectTo ? `?next=${redirectTo}` : ''}`,
            },
        });
        if (error) throw error;
    };

    const signInWithGoogle = async (redirectTo?: string) => {
        const { error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: `${window.location.origin}/auth/callback${redirectTo ? `?next=${redirectTo}` : ''}`,
            },
        });
        if (error) throw error;
    };

    const signOut = async () => {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
    };

    return {
        user,
        dbUser,
        loading,
        signInWithKakao,
        signInWithGoogle,
        signOut,
    };
}
