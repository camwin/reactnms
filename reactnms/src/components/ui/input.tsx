import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-11 w-full min-w-0 rounded-lg border border-line bg-surface px-3 text-sm text-fg outline-none placeholder:text-faint',
        className,
      )}
      {...props}
    />
  );
}
