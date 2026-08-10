export function RepairsShell({ children }: { children: JSX.Element }): JSX.Element {
	return (
		<div className="inv repairs-shell">
			<header>
				<h1>🔧 Ремонты</h1>
				<p className="subtitle">Приём оборудования и сдача в ремонт · приём → отправлено → вернулось → выдано</p>
			</header>
			<section>{children}</section>
		</div>
	);
}
